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
					choice: "candidate_000",
					confidence: 0.4,
					probabilities: { candidate_000: 0.4, candidate_001: 0.3, candidate_002: 0.1, candidate_003: 0.3 },
				},
			}),
			response({
				candidate: {
					type: "choice",
					choice: "candidate_001",
					confidence: 0.9,
					probabilities: { candidate_000: 0.05, candidate_001: 0.9, candidate_002: 0.05 },
				},
				fits: { type: "noul", noul: 0.95 },
			}),
		);
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		await expect(selectJevCandidate(client, "fix the bug", candidates, { timeoutMs: 100 })).resolves.toEqual({
			ok: true,
			id: "implementation",
			probability: 0.9,
			fit: 0.95,
		});
	});

	it("rejects a selected candidate when fit is low", async () => {
		const fetch = queuedFetch(
			response({
				candidate: {
					type: "choice",
					choice: "candidate_000",
					confidence: 0.9,
					probabilities: { candidate_000: 0.9, candidate_001: 0.04, candidate_002: 0.03, candidate_003: 0.03 },
				},
			}),
			response({
				candidate: {
					type: "choice",
					choice: "candidate_000",
					confidence: 0.9,
					probabilities: { candidate_000: 0.9, candidate_001: 0.05, candidate_002: 0.05 },
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

	it("rejects low selected probability and unknown reranked labels", async () => {
		const broad = () =>
			response({
				candidate: {
					type: "choice",
					choice: "candidate_000",
					confidence: 0.9,
					probabilities: { candidate_000: 0.4, candidate_001: 0.3, candidate_002: 0.2, candidate_003: 0.1 },
				},
			});
		const reranked = (choice: string, probability: number) =>
			response({
				candidate: {
					type: "choice",
					choice,
					confidence: 0.99,
					probabilities: { candidate_000: probability, candidate_001: 0.3, candidate_002: 0.3 },
				},
				fits: { type: "noul", noul: 0.9 },
			});
		const client = createJevClient({
			apiKey: "test",
			fetch: queuedFetch(broad(), reranked("candidate_000", 0.2), broad(), reranked("unknown", 0.9)),
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
			probability: 1,
			fit: 0.9,
		});
	});

	it("preserves caller order for integer-like candidate IDs", async () => {
		const fetch = queuedFetch(
			response({
				candidate: {
					type: "choice",
					choice: "candidate_000",
					confidence: 0.8,
					probabilities: { candidate_000: 0.8, candidate_001: 0.2 },
				},
			}),
			response({
				candidate: {
					type: "choice",
					choice: "candidate_000",
					confidence: 0.8,
					probabilities: { candidate_000: 0.8, candidate_001: 0.2 },
				},
				fits: { type: "noul", noul: 0.9 },
			}),
		);
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		await expect(
			selectJevCandidate(
				client,
				"task",
				[
					{ id: "10", description: "first" },
					{ id: "2", description: "second" },
				],
				{ timeoutMs: 100 },
			),
		).resolves.toEqual({ ok: true, id: "10", probability: 0.8, fit: 0.9 });
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
