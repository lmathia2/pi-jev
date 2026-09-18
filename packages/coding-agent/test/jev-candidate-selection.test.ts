import type { Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { createJevClient, selectJevCandidate } from "../src/jev/client.ts";

const candidates = [
	{ id: "code-search", description: "Find relevant code" },
	{ id: "implementation", description: "Change code" },
	{ id: "research", description: "Research external sources" },
	{ id: "tests", description: "Diagnose tests" },
];

function response(answers: object): Response {
	return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function queuedFetch(...responses: Response[]): Fetch {
	return async () => responses.shift() ?? response({});
}

describe("selectJevCandidate", () => {
	it("reranks a stable top-three shortlist and accepts a fitting candidate", async () => {
		const fetch = queuedFetch(
			response({
				candidate: {
					type: "choice",
					choice: "code-search",
					confidence: 0.4,
					probabilities: { "code-search": 0.4, implementation: 0.3, research: 0.1, tests: 0.3 },
				},
			}),
			response({
				candidate: {
					type: "choice",
					choice: "implementation",
					confidence: 0.9,
					probabilities: { "code-search": 0.05, implementation: 0.9, tests: 0.05 },
				},
				fits: { type: "noul", noul: 0.95 },
			}),
		);
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		await expect(selectJevCandidate(client, "fix the bug", candidates, { timeoutMs: 100 })).resolves.toEqual({
			ok: true,
			id: "implementation",
			confidence: 0.9,
			fit: 0.95,
		});
	});

	it("rejects a selected candidate when fit is low", async () => {
		const fetch = queuedFetch(
			response({
				candidate: {
					type: "choice",
					choice: "code-search",
					confidence: 0.9,
					probabilities: { "code-search": 0.9, implementation: 0.04, research: 0.03, tests: 0.03 },
				},
			}),
			response({
				candidate: {
					type: "choice",
					choice: "code-search",
					confidence: 0.9,
					probabilities: { "code-search": 0.9, implementation: 0.05, research: 0.05 },
				},
				fits: { type: "noul", noul: 0.2 },
			}),
		);
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		await expect(selectJevCandidate(client, "unrelated", candidates, { timeoutMs: 100 })).resolves.toEqual({
			ok: false,
			failure: "rejected",
		});
	});

	it("rejects low confidence and unknown reranked IDs", async () => {
		const broad = () =>
			response({
				candidate: {
					type: "choice",
					choice: "code-search",
					confidence: 0.9,
					probabilities: { "code-search": 0.4, implementation: 0.3, research: 0.2, tests: 0.1 },
				},
			});
		const reranked = (choice: string, confidence: number) =>
			response({
				candidate: {
					type: "choice",
					choice,
					confidence,
					probabilities: { "code-search": 0.4, implementation: 0.3, research: 0.3 },
				},
				fits: { type: "noul", noul: 0.9 },
			});
		const client = createJevClient({
			apiKey: "test",
			fetch: queuedFetch(broad(), reranked("code-search", 0.2), broad(), reranked("unknown", 0.9)),
			timeoutMs: 100,
		});

		await expect(selectJevCandidate(client, "task", candidates, { timeoutMs: 100 })).resolves.toEqual({
			ok: false,
			failure: "rejected",
		});
		await expect(selectJevCandidate(client, "task", candidates, { timeoutMs: 100 })).resolves.toEqual({
			ok: false,
			failure: "invalid_response",
		});
	});

	it("handles zero and one candidate without an invalid Choice request", async () => {
		const fetch = queuedFetch(response({ fits: { type: "noul", noul: 0.9 } }));
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		await expect(selectJevCandidate(client, "task", [], { timeoutMs: 100 })).resolves.toEqual({
			ok: false,
			failure: "no_candidates",
		});
		await expect(selectJevCandidate(client, "task", [candidates[0]], { timeoutMs: 100 })).resolves.toEqual({
			ok: true,
			id: "code-search",
			confidence: 1,
			fit: 0.9,
		});
	});

	it("rejects duplicate IDs and candidate sets above the service limit", async () => {
		const client = createJevClient({ apiKey: "test", fetch: queuedFetch(), timeoutMs: 100 });

		await expect(
			selectJevCandidate(client, "task", [candidates[0], candidates[0]], { timeoutMs: 100 }),
		).resolves.toEqual({
			ok: false,
			failure: "invalid_response",
		});
		await expect(
			selectJevCandidate(
				client,
				"task",
				Array.from({ length: 256 }, (_, index) => ({ id: String(index), description: "candidate" })),
				{ timeoutMs: 100 },
			),
		).resolves.toEqual({ ok: false, failure: "invalid_response" });
	});
});
