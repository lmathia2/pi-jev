import type { Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { createJevClient } from "../src/jev/client.ts";
import { selectJevContext } from "../src/jev/context-selector.ts";
import type { ContextCandidate } from "../src/jev/types.ts";

const candidates: ContextCandidate[] = [
	{
		id: "policy",
		source: "document",
		label: "policy",
		excerpt: "Always retain",
		required: true,
	},
	{
		id: "old",
		source: "message",
		label: "old turn",
		excerpt: "Unrelated styling discussion",
		required: false,
	},
	{
		id: "code",
		source: "file",
		label: "runtime.ts",
		excerpt: "Generation runtime",
		required: false,
	},
	{
		id: "test",
		source: "file",
		label: "runtime.test.ts",
		excerpt: "Generation tests",
		required: false,
	},
];

function fetchResult(fit: number): Fetch {
	return async () =>
		new Response(
			JSON.stringify({
				model: "jev-test",
				answers: {
					where: {
						type: "choice",
						choice: "code",
						confidence: 0.8,
						probabilities: { old: 0.1, code: 0.6, test: 0.3 },
					},
					exists: { type: "noul", noul: fit },
				},
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
}

describe("selectJevContext", () => {
	it("retains required context and returns relevant optional candidates in original order", async () => {
		const client = createJevClient({ apiKey: "test", fetch: fetchResult(0.9), timeoutMs: 100 });

		await expect(selectJevContext("trace generation", candidates, { client, maxOptional: 2 })).resolves.toEqual([
			"policy",
			"code",
			"test",
		]);
		expect(candidates.map((candidate) => candidate.id)).toEqual(["policy", "old", "code", "test"]);
	});

	it("falls back to all context when answer presence is not verified", async () => {
		const client = createJevClient({ apiKey: "test", fetch: fetchResult(0.2), timeoutMs: 100 });

		await expect(selectJevContext("missing answer", candidates, { client, maxOptional: 1 })).resolves.toEqual([
			"policy",
			"old",
			"code",
			"test",
		]);
	});

	it("falls back before calling Jev for duplicate IDs", async () => {
		let calls = 0;
		const unusedFetch = fetchResult(0.9);
		const client = createJevClient({
			apiKey: "test",
			fetch: async (url, init) => {
				calls += 1;
				return unusedFetch(url, init);
			},
			timeoutMs: 100,
		});
		const duplicate = [...candidates, { ...candidates[0] }];

		await expect(selectJevContext("task", duplicate, { client })).resolves.toEqual(duplicate.map(({ id }) => id));
		expect(calls).toBe(0);
	});

	it("falls back when optional candidates exceed the Choice limit", async () => {
		const client = createJevClient({ apiKey: "test", fetch: fetchResult(0.9), timeoutMs: 100 });
		const oversized: ContextCandidate[] = Array.from({ length: 256 }, (_, index) => ({
			id: String(index),
			source: "message",
			label: String(index),
			excerpt: "context",
			required: false,
		}));

		await expect(selectJevContext("task", oversized, { client })).resolves.toEqual(oversized.map(({ id }) => id));
	});

	it("uses only answer verification for one optional candidate", async () => {
		const client = createJevClient({
			apiKey: "test",
			fetch: async () =>
				new Response(
					JSON.stringify({
						model: "jev-test",
						answers: { exists: { type: "noul", noul: 0.9 } },
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			timeoutMs: 100,
		});

		await expect(selectJevContext("task", [candidates[0], candidates[2]], { client })).resolves.toEqual([
			"policy",
			"code",
		]);
	});
});
