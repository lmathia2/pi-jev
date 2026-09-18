import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Fetch } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGenerationRoutingExtension,
	type GenerationRouteProvider,
	type GenerationRouteRecord,
} from "../../src/core/generation-routing.ts";
import { createConfiguredGenerationRoutingExtension } from "../../src/jev/runtime.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("generation routing", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("does not await or mutate execution in shadow mode", async () => {
		const provider: GenerationRouteProvider = {
			decide: () => new Promise(() => {}),
		};
		harness = await createHarness({
			extensionFactories: [createGenerationRoutingExtension({ provider, routes: {}, shadow: true })],
		});
		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.prompt("task");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.thinkingLevel).toBe("off");
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
