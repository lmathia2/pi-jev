import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Fetch } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGenerationRoutingExtension,
	defaultGenerationRouteProvider,
	type GenerationRouteProvider,
	type GenerationRouteRecord,
} from "../../src/core/generation-routing.ts";
import { createConfiguredGenerationRoutingExtension } from "../../src/jev/runtime.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("generation routing", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("preserves execution with the default provider", async () => {
		harness = await createHarness({
			extensionFactories: [
				createGenerationRoutingExtension({ provider: defaultGenerationRouteProvider, routes: {} }),
			],
		});
		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.prompt("task");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.thinkingLevel).toBe("off");
	});

	it("does not register routing when off, unconfigured, or missing a key", () => {
		expect(createConfiguredGenerationRoutingExtension({}, { apiKey: "test" })).toBeUndefined();
		expect(createConfiguredGenerationRoutingExtension({ mode: "off" }, { apiKey: "test" })).toBeUndefined();
		expect(createConfiguredGenerationRoutingExtension({ mode: "route" }, { apiKey: "" })).toBeUndefined();
	});

	it("does not enable routing for removed shadow settings loaded from JSON", () => {
		expect(
			createConfiguredGenerationRoutingExtension(JSON.parse('{"mode":"shadow"}'), { apiKey: "test" }),
		).toBeUndefined();
	});

	it("falls back on provider errors and isolates telemetry callback failures", async () => {
		const records: GenerationRouteRecord[] = [];
		harness = await createHarness({
			extensionFactories: [
				createGenerationRoutingExtension({
					provider: {
						async decide() {
							throw new Error("provider unavailable");
						},
					},
					routes: {},
					onRecord(record) {
						records.push(record);
						throw new Error("telemetry unavailable");
					},
				}),
			],
		});
		harness.setResponses([fauxAssistantMessage("response")]);
		await harness.session.prompt("private task text");
		expect(harness.faux.state.callCount).toBe(1);
		expect(records).toEqual([{ kind: "route", turn: 1, fallback: "provider_error" }]);
	});

	it("applies a validated route profile", async () => {
		const records: GenerationRouteRecord[] = [];
		const provider: GenerationRouteProvider = {
			async decide() {
				return { decision: { route: "deep", probability: 0.92, fit: 0.95 } };
			},
		};
		harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true }],
			extensionFactories: [
				createGenerationRoutingExtension({
					provider,
					routes: { deep: { thinkingLevel: "high", tools: [] } },
					onRecord: (record) => records.push(record),
				}),
			],
		});
		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.prompt("task");

		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(records).toEqual([
			{
				kind: "route",
				turn: 1,
				decision: { route: "deep", probability: 0.92, fit: 0.95 },
				applied: { thinkingLevel: "high", tools: [] },
			},
		]);
	});

	it("maps a configured Jev decision through the same routing component", async () => {
		const fetch: Fetch = async () =>
			new Response(
				JSON.stringify({
					model: "jev-test",
					answers: {
						route: {
							type: "choice",
							choice: "deep",
							confidence: 0.92,
							probabilities: { fast: 0.02, standard: 0.04, deep: 0.92, research: 0.02 },
						},
						fits: { type: "noul", noul: 0.95 },
					},
					usage: { input_tokens: 10, output_tokens: 5 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		const extension = createConfiguredGenerationRoutingExtension(
			{ mode: "route", routes: { deep: { thinkingLevel: "high" } } },
			{ apiKey: "test", fetch },
		);
		expect(extension).toBeDefined();
		harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true }],
			extensionFactories: extension ? [extension] : [],
		});
		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.prompt("task");

		expect(harness.session.thinkingLevel).toBe("high");
	});
});
