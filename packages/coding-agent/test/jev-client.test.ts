import type { Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { createJevClient, decideJevRoute } from "../src/jev/client.ts";

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const successBody = {
	model: "jev-test",
	answers: {
		route: {
			type: "choice",
			choice: "deep",
			confidence: 0.91,
			probabilities: { fast: 0.01, standard: 0.07, deep: 0.91, research: 0.01 },
		},
		fits: { type: "noul", noul: 0.96 },
	},
	usage: { input_tokens: 20, output_tokens: 8 },
};

describe("decideJevRoute", () => {
	it("returns a validated typed route", async () => {
		let requestBody: unknown;
		const fetch: Fetch = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return response(successBody);
		};
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		const result = await decideJevRoute(client, "Trace the durable state machine", { timeoutMs: 100 });

		expect(result).toMatchObject({
			ok: true,
			decision: { route: "deep", confidence: 0.91, fit: 0.96, model: "jev-test" },
		});
		expect(requestBody).toMatchObject({
			state: { task: "Trace the durable state machine" },
			questions: { route: { type: "choice" }, fits: { type: "noul" } },
		});
	});

	it("rejects an unknown route", async () => {
		const fetch: Fetch = async () =>
			response({
				...successBody,
				answers: { ...successBody.answers, route: { ...successBody.answers.route, choice: "unknown" } },
			});
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		await expect(decideJevRoute(client, "task", { timeoutMs: 100 })).resolves.toMatchObject({
			ok: false,
			failure: "invalid_response",
		});
	});

	it("classifies rate limiting after SDK retries", async () => {
		let calls = 0;
		const fetch: Fetch = async () => {
			calls += 1;
			return response({ error: "limited" }, 429);
		};
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });

		await expect(decideJevRoute(client, "task", { timeoutMs: 2_000 })).resolves.toMatchObject({
			ok: false,
			failure: "rate_limit",
		});
		expect(calls).toBe(3);
	});

	it("classifies a bounded request timeout", async () => {
		const fetch: Fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				if (init?.signal?.aborted) {
					reject(init.signal.reason);
					return;
				}
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 5 });

		await expect(decideJevRoute(client, "task", { timeoutMs: 5 })).resolves.toMatchObject({
			ok: false,
			failure: "timeout",
		});
	});

	it("distinguishes caller cancellation", async () => {
		const fetch: Fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				if (init?.signal?.aborted) {
					reject(init.signal.reason);
					return;
				}
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		const client = createJevClient({ apiKey: "test", fetch, timeoutMs: 100 });
		const controller = new AbortController();
		controller.abort();

		await expect(
			decideJevRoute(client, "task", { signal: controller.signal, timeoutMs: 100 }),
		).resolves.toMatchObject({ ok: false, failure: "aborted" });
	});
});
