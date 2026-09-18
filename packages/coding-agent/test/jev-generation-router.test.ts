import { BACKGROUND_CONTEXT, type LaneConfiguration } from "@earendil-works/pi-agent-core";
import type { Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { createJevClient } from "../src/jev/client.ts";
import { createJevGenerationRouter } from "../src/jev/generation-router.ts";
import type { JevRouteId } from "../src/jev/types.ts";

const base: LaneConfiguration = {
	model: { provider: "test", modelId: "standard" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
};

const routes: Record<JevRouteId, Partial<LaneConfiguration>> = {
	fast: { model: { provider: "test", modelId: "fast" } },
	standard: {},
	deep: { model: { provider: "test", modelId: "deep" }, thinkingLevel: "high" },
	research: { activeToolNames: ["read", "web"] },
};

function fetchWithFit(fit: number): Fetch {
	return async () =>
		new Response(
			JSON.stringify({
				model: "jev-test",
				answers: {
					route: {
						type: "choice",
						choice: "deep",
						confidence: 0.9,
						probabilities: { fast: 0.02, standard: 0.07, deep: 0.9, research: 0.01 },
					},
					fits: { type: "noul", noul: fit },
				},
				usage: { input_tokens: 10, output_tokens: 5 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
}

describe("createJevGenerationRouter", () => {
	it("returns the mapped route when confidence and fit pass", async () => {
		const client = createJevClient({ apiKey: "test", fetch: fetchWithFit(0.95), timeoutMs: 100 });
		const route = createJevGenerationRouter({ client, routes });

		await expect(
			route(
				{
					lane: "main",
					runId: "run",
					configuration: base,
					messages: [{ role: "user", content: "trace the runtime", timestamp: 1 }],
					attempt: 1,
				},
				BACKGROUND_CONTEXT,
			),
		).resolves.toEqual({
			configuration: { model: { provider: "test", modelId: "deep" }, thinkingLevel: "high" },
		});
	});

	it("falls back when the independent fit check is below threshold", async () => {
		const client = createJevClient({ apiKey: "test", fetch: fetchWithFit(0.2), timeoutMs: 100 });
		const route = createJevGenerationRouter({ client, routes });

		await expect(
			route(
				{
					lane: "main",
					runId: "run",
					configuration: base,
					messages: [{ role: "user", content: "task", timestamp: 1 }],
					attempt: 1,
				},
				BACKGROUND_CONTEXT,
			),
		).resolves.toBeUndefined();
	});
});
