import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { DecisionRegistry, type DecisionRequest } from "@earendil-works/pi-decisions";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import {
	createDecisionRoutingExtension,
	type DecisionRoutingSettings,
	estimateRoutingCosts,
	validateDecisionRoutingSettings,
} from "../../src/jev/decision-routing.ts";
import { createConfiguredDecisionExtension } from "../../src/jev/decision-runtime.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

function settings(): DecisionRoutingSettings {
	return {
		binding: { implementation: "fixture", policy: {} },
		phases: ["investigate", "verify"],
		routes: [
			{
				id: "configured",
				description: "Configured model",
				provider: "faux",
				model: "faux-1",
				effort: "off",
				tools: [],
			},
		],
		requiredTools: [],
		timeoutMs: 1000,
		maxDecisions: 20,
		estimate: { requests: 2, outputTokens: 1000, marginUsd: 0.001, decisionCostUsd: 0 },
	};
}

it("prices a cold switch once and rejects unknown or invalid economics", () => {
	const costs = estimateRoutingCosts({
		promptTokens: 100000,
		cachedTokens: 100000,
		requests: 1,
		outputTokens: 0,
		current: { input: 10, cacheRead: 1, cacheWrite: 12, output: 10 },
		target: { input: 2, cacheRead: 0.2, cacheWrite: 3, output: 2 },
		decisionCostUsd: 0.01,
	});
	expect(costs).toEqual({ stay: 0.1, switch: 0.31 });
	expect(
		estimateRoutingCosts({
			promptTokens: NaN,
			cachedTokens: 0,
			requests: 1,
			outputTokens: 0,
			current: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
			target: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
			decisionCostUsd: 0,
		}),
	).toBeUndefined();
});

it("validates complete presets and preserves required tools at the config boundary", () => {
	const config = settings();
	config.requiredTools = ["read"];
	expect(() => validateDecisionRoutingSettings(config)).toThrow("preset");
	config.routes[0].tools = ["read"];
	expect(() => validateDecisionRoutingSettings(config)).not.toThrow();
	config.routes.push(config.routes[0]);
	expect(() => validateDecisionRoutingSettings(config)).toThrow("Duplicate");
});

it("pins routing across real tool turns, new user turns and reload, then admits an explicit phase", async () => {
	const requests: DecisionRequest[] = [];
	const registry = new DecisionRegistry();
	registry.register({
		id: "fixture",
		version: "1",
		definitions: ["generation.route/v1"],
		async evaluate(request) {
			requests.push(request);
			return { status: "proposed", answer: { kind: "select", candidateId: "keep_current" } };
		},
	});
	const factories: InlineExtension[] = [
		createDecisionRoutingExtension({ registry, settings: settings(), features: () => ({ privateBudget: 7 }) }),
		(pi) => {
			pi.registerTool({
				name: "step",
				label: "Step",
				description: "Step",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }),
			});
		},
	];
	let extensions = await createTestExtensionsResult(factories);
	const loader = createTestResourceLoader();
	loader.getExtensions = () => extensions;
	loader.reload = async () => {
		extensions = await createTestExtensionsResult(factories);
	};
	harness = await createHarness({ resourceLoader: loader });
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" }),
		(context) => {
			expect(getCurrentSystemPrompt(context.messages)).not.toContain("privateBudget");
			return fauxAssistantMessage("done");
		},
		fauxAssistantMessage("next"),
		fauxAssistantMessage("verify"),
		fauxAssistantMessage("still verify"),
	]);
	await harness.session.prompt("inspect this");
	await harness.session.prompt("/decision-phase investigate");
	expect(
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "decision-phase"),
	).toHaveLength(0);
	await harness.session.reload();
	await harness.session.prompt("more work in same phase");
	expect(requests).toHaveLength(1);
	expect(requests[0].features.privateBudget).toBe(7);
	expect(requests[0].features.task).toContain("inspect this");
	await harness.session.prompt("/decision-phase verify");
	await harness.session.prompt("verify now");
	expect(requests).toHaveLength(2);
	expect(requests[1].features.phase).toBe("verify");
	expect(requests[1].features.history).not.toEqual([]);
	await harness.session.prompt("/decision-phase verify");
	await harness.session.prompt("same verify phase");
	expect(requests).toHaveLength(2);
});

it("does not finance switches with hypothetical target cache hits", () => {
	expect(
		estimateRoutingCosts({
			promptTokens: 1000000,
			cachedTokens: 1000000,
			requests: 3,
			outputTokens: 0,
			current: { input: 10, cacheRead: 1, cacheWrite: 10, output: 0 },
			target: { input: 2, cacheRead: 0.01, cacheWrite: 2, output: 0 },
			decisionCostUsd: 0,
		}),
	).toEqual({ stay: 3, switch: 6 });
});

it("does not apply stale proposals", async () => {
	const registry = new DecisionRegistry();
	registry.register({
		id: "fixture",
		version: "1",
		definitions: ["generation.route/v1"],
		async evaluate() {
			harness!.sessionManager.appendCustomEntry("external-update", {});
			return { status: "proposed", answer: { kind: "select", candidateId: "configured" } };
		},
	});
	harness = await createHarness({
		extensionFactories: [createDecisionRoutingExtension({ registry, settings: settings() })],
	});
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("task");
	expect(
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "decision-route"),
	).toHaveLength(0);
});

it("invalid bundles disable all decisions and report diagnostics", async () => {
	const errors: unknown[] = [];
	const extension = createConfiguredDecisionExtension(
		{ routing: settings() },
		{ onError: (error) => errors.push(error) },
	);
	harness = await createHarness({ extensionFactories: [extension] });
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("task");
	expect(errors).toHaveLength(1);
	expect(harness.faux.state.callCount).toBe(1);
});

it("selects an injected plugin and passes config-only policy changes without a Jev client", async () => {
	let observed: unknown;
	const config = settings();
	config.binding.policy = { preference: "config-only-value" };
	const extension = createConfiguredDecisionExtension(
		{ routing: config },
		{
			implementations: [
				{
					id: "fixture",
					version: "1",
					definitions: ["generation.route/v1"],
					async evaluate(_request, policy) {
						observed = policy.preference;
						return {
							status: "proposed",
							answer: { kind: "select", candidateId: "keep_current" },
							usage: { requests: 0, costUsd: 0 },
						};
					},
				},
			],
		},
	);
	harness = await createHarness({ extensionFactories: [extension] });
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("task");
	expect(observed).toBe("config-only-value");
});
