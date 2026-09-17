import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Fetch } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createJevShadowExtension } from "../../src/jev/shadow.ts";
import type { JevShadowRecord } from "../../src/jev/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const successBody = {
	model: "jev-test",
	answers: {
		route: {
			type: "choice",
			choice: "standard",
			confidence: 0.88,
			probabilities: { fast: 0.05, standard: 0.88, deep: 0.06, research: 0.01 },
		},
		fits: { type: "noul", noul: 0.93 },
	},
	usage: { input_tokens: 12, output_tokens: 8 },
};

describe("Jev shadow extension", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("observes a run without changing execution or retaining prompt text", async () => {
		const records: JevShadowRecord[] = [];
		const fetch: Fetch = async () =>
			new Response(JSON.stringify(successBody), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		harness = await createHarness({
			extensionFactories: [
				createJevShadowExtension({ apiKey: "test", fetch, onRecord: (record) => records.push(record) }),
			],
		});
		harness.setResponses([fauxAssistantMessage("unchanged response")]);

		await harness.session.prompt("private task text");

		expect(harness.faux.state.callCount).toBe(1);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			kind: "route",
			turn: 1,
			result: { ok: true, decision: { route: "standard", fit: 0.93 } },
		});
		expect(records[1]).toEqual({
			kind: "outcome",
			turn: 1,
			modelCalls: 1,
			toolCalls: 0,
			compactions: 0,
		});
		expect(JSON.stringify(records)).not.toContain("private task text");
	});

	it("is disabled when an explicit API key is empty", async () => {
		const records: JevShadowRecord[] = [];
		let calls = 0;
		harness = await createHarness({
			extensionFactories: [
				createJevShadowExtension({
					apiKey: "",
					fetch: async () => {
						calls += 1;
						return new Response();
					},
					onRecord: (record) => records.push(record),
				}),
			],
		});
		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.prompt("task");

		expect(calls).toBe(0);
		expect(records).toEqual([]);
	});

	it("does not let telemetry failures affect the run", async () => {
		const fetch: Fetch = async () =>
			new Response(JSON.stringify(successBody), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		harness = await createHarness({
			extensionFactories: [
				createJevShadowExtension({
					apiKey: "test",
					fetch,
					onRecord: () => {
						throw new Error("telemetry unavailable");
					},
				}),
			],
		});
		harness.setResponses([fauxAssistantMessage("response")]);

		await expect(harness.session.prompt("task")).resolves.toBeUndefined();
		expect(harness.faux.state.callCount).toBe(1);
	});
});
