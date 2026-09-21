import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { DecisionRegistry } from "@earendil-works/pi-decisions";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import {
	createDecisionRoutingExtension,
	type DecisionRoutingSettings,
	estimateRoutingCosts,
} from "../../src/jev/decision-routing.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	harness?.cleanup();
});

const settings: DecisionRoutingSettings = {
	binding: { implementation: "pick", policy: {} },
	routes: [{ id: "cheap", description: "Cheap", provider: "faux", model: "cheap", effort: "high", tools: [] }],
	phases: ["work"],
	requiredTools: [],
	timeoutMs: 1000,
	maxDecisions: 5,
	estimate: { requests: 2, outputTokens: 1000, decisionCostUsd: 0, marginUsd: 0 },
};

it("commits the complete preset before notifications and preserves newer listener choices", async () => {
	const registry = new DecisionRegistry();
	registry.register({
		id: "pick",
		version: "1",
		definitions: ["generation.route/v1"],
		async evaluate() {
			return { status: "proposed", answer: { kind: "select", candidateId: "cheap" } };
		},
	});
	harness = await createHarness({
		models: [
			{ id: "expensive", cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 10 } },
			{ id: "cheap", reasoning: true, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } },
		],
		extensionFactories: [
			createDecisionRoutingExtension({ registry, settings }),
			(pi) => {
				pi.on("model_select", () => {
					expect(pi.getThinkingLevel()).toBe("high");
					expect(pi.getActiveTools()).toEqual([]);
					pi.setThinkingLevel("low");
				});
			},
		],
	});
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("implement");
	expect(harness.session.thinkingLevel).toBe("low");
	expect(
		harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === "decision-route"),
	).toMatchObject({ data: { fallback: "superseded", effective: { effort: "low" } } });
});

it("can route the first request using structured state before cache usage exists", async () => {
	const registry = new DecisionRegistry();
	registry.register({
		id: "pick",
		version: "1",
		definitions: ["generation.route/v1"],
		async evaluate(request) {
			expect(request.features.contextTokens).toBeGreaterThan(0);
			return { status: "proposed", answer: { kind: "select", candidateId: "cheap" } };
		},
	});
	harness = await createHarness({
		models: [
			{ id: "expensive", cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 10 } },
			{ id: "cheap", reasoning: true, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } },
		],
		extensionFactories: [createDecisionRoutingExtension({ registry, settings })],
	});
	harness.setResponses([
		(context) => {
			expect(getCurrentTools(context.messages)).toEqual([]);
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("implement");
	expect(harness.session.model!.id).toBe("cheap");
	expect(harness.session.thinkingLevel).toBe("high");
	const entries = harness.sessionManager.getBranch();
	const pending = entries.findIndex(
		(entry) => entry.type === "custom" && entry.customType === "decision-route-pending",
	);
	const effective = entries.findIndex((entry) => entry.type === "custom" && entry.customType === "decision-route");
	expect(pending).toBeGreaterThanOrEqual(0);
	expect(effective).toBeGreaterThan(pending);
});

it("checks model freshness after asynchronous authentication before mutation", async () => {
	let api: ExtensionAPI | undefined;
	harness = await createHarness({
		models: [{ id: "first" }, { id: "second" }],
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	const auth = await harness.session.modelRuntime.checkAuth(harness.getModel().provider);
	let release = () => {};
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async () => {
		await waiting;
		return auth;
	});
	let fresh = true;
	const changing = api!.setModel(harness.getModel("second")!, { beforeApply: () => fresh });
	fresh = false;
	release();
	expect(await changing).toBe(false);
	expect(harness.session.model!.id).toBe("first");
	expect(harness.sessionManager.getBranch().some((entry) => entry.type === "model_change")).toBe(false);
});

it("recovers an interrupted apply without evaluating a second proposal", async () => {
	let calls = 0;
	const registry = new DecisionRegistry();
	registry.register({
		id: "pick",
		version: "1",
		definitions: ["generation.route/v1"],
		async evaluate() {
			calls++;
			return { status: "abstained", reason: "unused" };
		},
	});
	harness = await createHarness({ extensionFactories: [createDecisionRoutingExtension({ registry, settings })] });
	harness.sessionManager.appendCustomEntry("decision-route-pending", { phase: "initial:work" });
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("continue");
	expect(calls).toBe(0);
	expect(
		harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === "decision-route"),
	).toMatchObject({ data: { fallback: "apply-interrupted" } });
});

it("does not assume free future input when a provider has no cache tariff", () => {
	const costs = estimateRoutingCosts({
		promptTokens: 1000000,
		cachedTokens: 0,
		requests: 3,
		outputTokens: 0,
		current: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 },
		target: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
		decisionCostUsd: 0,
	});
	expect(costs).toEqual({ stay: 6, switch: 3 });
});

it.each([
	{ minimumTokens: undefined, reserveTokens: 4096, eligible: false },
	{ minimumTokens: 1000, reserveTokens: 4096, eligible: true },
	{ minimumTokens: 63000, reserveTokens: 4096, eligible: false },
	{ minimumTokens: 1000, reserveTokens: 63000, eligible: false },
])("admits a smaller window only with a fitting protected floor: %j", async (testCase) => {
	const registry = new DecisionRegistry();
	let evaluated = false;
	registry.register({
		id: "pick",
		version: "1",
		definitions: ["generation.route/v1"],
		async evaluate(request) {
			evaluated = true;
			expect(request.candidates.some(({ id }) => id === "cheap")).toBe(testCase.eligible);
			return {
				status: "proposed",
				answer: { kind: "select", candidateId: testCase.eligible ? "cheap" : "keep_current" },
			};
		},
	});
	const minimumTokens = testCase.minimumTokens;
	harness = await createHarness({
		models: [
			{
				id: "expensive",
				contextWindow: 200000,
				maxTokens: 4096,
				cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 10 },
			},
			{
				id: "cheap",
				contextWindow: 64000,
				maxTokens: 4096,
				reasoning: true,
				cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
			},
		],
		extensionFactories: [
			createDecisionRoutingExtension({
				registry,
				settings,
				contextRequirements:
					minimumTokens === undefined
						? undefined
						: () => ({
								minimumTokens,
								fullTokens: 100000,
								reserveTokens: testCase.reserveTokens,
								safetyMarginTokens: 512,
							}),
			}),
		],
	});
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("implement");
	expect(evaluated).toBe(true);
	expect(harness.session.model!.id).toBe(testCase.eligible ? "cheap" : "expensive");
});

it("classifies settled work, keeps a phase without rerouting, and applies only configured transitions", async () => {
	let routes = 0;
	let phases = 0;
	const registry = new DecisionRegistry();
	registry.register({
		id: "phase-and-route",
		version: "1",
		definitions: ["generation.route/v1", "generation.phase/v1"],
		async evaluate(request) {
			if (request.definition === "generation.route/v1") {
				routes++;
				return { status: "proposed", answer: { kind: "select", candidateId: "keep_current" } };
			}
			phases++;
			expect(request.candidates.map(({ id }) => id)).toEqual(["work", "verify"]);
			return { status: "proposed", answer: { kind: "select", candidateId: phases === 1 ? "work" : "verify" } };
		},
	});
	harness = await createHarness({
		extensionFactories: [
			createDecisionRoutingExtension({
				registry,
				settings: {
					...settings,
					binding: { implementation: "phase-and-route", policy: {} },
					phases: ["work", "verify"],
					phaseBinding: { implementation: "phase-and-route", policy: {} },
					transitions: { work: ["verify"] },
					maxPhaseDecisions: 2,
				},
			}),
			(pi) =>
				pi.registerTool({
					name: "step",
					label: "Step",
					description: "Step",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				}),
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" }),
		() => {
			expect(routes).toBe(1);
			return fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("done"),
		fauxAssistantMessage("another prompt"),
	]);
	await harness.session.prompt("work");
	await harness.session.prompt("same phase");
	expect(routes).toBe(2);
	expect(phases).toBe(2);
	expect(
		harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "decision-phase-check"),
	).toHaveLength(2);
	expect(
		harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === "decision-phase"),
	).toMatchObject({ data: { phase: "verify" } });
});
