import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import type { DecisionRequest } from "../src/contracts.ts";
import { DecisionRegistry, loadPolicyPackage, PolicyStore } from "../src/index.ts";
import { createJevImplementation } from "../src/jev.ts";

const request: DecisionRequest = {
	definition: "generation.route/v1",
	boundaryId: "b",
	stateRevision: "1",
	features: { private: "state" },
	candidates: [
		{ id: "model/one:high", description: "First", attributes: {} },
		{ id: "model/two:low", description: "Second", attributes: {} },
	],
};
const policy = {
	instructions: "Choose by task fit",
	minProbability: 0.8,
	criteria: { true: "Needed", false: "Unnecessary" },
};

describe("Jev implementation", () => {
	it("loads every documented sample policy without inference", () => {
		const registry = new DecisionRegistry();
		registry.register(
			createJevImplementation(
				new TypeSafeClient({
					apiKey: "test",
					fetch: async () => {
						throw new Error("unexpected inference");
					},
				}),
			),
		);
		const policies = loadPolicyPackage(fileURLToPath(new URL("../examples/policies", import.meta.url)));
		const store = new PolicyStore((artifact) =>
			registry.validatePolicy(artifact.implementation, artifact.definition, artifact.policy),
		);
		store.activate(policies);
		expect(policies).toHaveLength(8);
	});
	it("counts transport work even when confidence rejects the answer", async () => {
		const implementation = createJevImplementation(
			new TypeSafeClient({
				apiKey: "test",
				fetch: async () =>
					Response.json({
						model: "fake",
						usage: { input_tokens: 10, output_tokens: 2 },
						answers: {
							selection: { type: "choice", choice: "c1", confidence: 0.6, probabilities: { c0: 0.4, c1: 0.6 } },
						},
					}),
			}),
		);
		expect(await implementation.evaluate(request, policy, new AbortController().signal)).toMatchObject({
			status: "abstained",
			usage: { requests: 1, tokens: 12 },
		});
	});
	it("maps opaque candidate IDs and sends private state without dependent batch questions", async () => {
		let body: unknown;
		const implementation = createJevImplementation(
			new TypeSafeClient({
				apiKey: "test",
				fetch: async (_url, init) => {
					body = JSON.parse(String(init?.body));
					return Response.json({
						model: "fake",
						usage: { input_tokens: 10, output_tokens: 2 },
						answers: {
							selection: { type: "choice", choice: "c1", confidence: 0.9, probabilities: { c0: 0.1, c1: 0.9 } },
						},
					});
				},
			}),
		);
		expect(await implementation.evaluate(request, policy, new AbortController().signal)).toMatchObject({
			status: "proposed",
			answer: { kind: "select", candidateId: "model/two:low" },
			usage: { requests: 1, tokens: 12 },
		});
		expect(body).toMatchObject({
			state: { features: { private: "state" } },
			questions: { selection: { instructions: policy.instructions } },
		});
		expect(Object.keys((body as { questions: object }).questions)).toEqual(["selection"]);
	});
	it("retains uncertain subset candidates and rejects invalid probabilities", async () => {
		let probability = 0.5;
		const implementation = createJevImplementation(
			new TypeSafeClient({
				apiKey: "test",
				fetch: async () =>
					Response.json({
						model: "fake",
						usage: { input_tokens: 10, output_tokens: 2 },
						answers: { c0: { type: "noul", noul: probability }, c1: { type: "noul", noul: 0.01 } },
					}),
			}),
		);
		expect(
			await implementation.evaluate(
				{ ...request, definition: "output.select/v1" },
				policy,
				new AbortController().signal,
			),
		).toMatchObject({ status: "proposed", answer: { kind: "subset", candidateIds: ["model/one:high"] } });
		probability = -1;
		expect(
			await implementation.evaluate(
				{ ...request, definition: "output.select/v1" },
				policy,
				new AbortController().signal,
			),
		).toMatchObject({ status: "failed" });
	});
	it("scores call and result evidence independently in one shared-state request without thresholding", async () => {
		let body: unknown;
		let calls = 0;
		let answers: Record<string, { type: string; noul: number }> = {
			c0: { type: "noul", noul: 0.5 },
			c1: { type: "noul", noul: 0.01 },
		};
		const registry = new DecisionRegistry();
		registry.register(
			createJevImplementation(
				new TypeSafeClient({
					apiKey: "test",
					fetch: async (_url, init) => {
						calls++;
						body = JSON.parse(String(init?.body));
						return Response.json({ model: "fake", usage: { input_tokens: 10, output_tokens: 2 }, answers });
					},
				}),
			),
		);
		const input: DecisionRequest = {
			...request,
			definition: "context.retention/v1",
			candidates: [
				{ id: "tool-1:call", description: "read arguments", attributes: { kind: "call" } },
				{ id: "tool-1:result", description: "file evidence", attributes: { kind: "result" } },
			],
		};
		expect((await registry.invoke("jev.typed", input, policy)).result).toMatchObject({
			status: "proposed",
			answer: { kind: "score", values: { "tool-1:call": 0.5, "tool-1:result": 0.01 } },
			usage: { requests: 1, tokens: 12 },
		});
		expect(calls).toBe(1);
		expect(body).toMatchObject({ state: { features: input.features } });
		expect(Object.keys((body as { questions: object }).questions)).toEqual(["c0", "c1"]);
		answers = { c0: { type: "noul", noul: 0.5 } };
		expect((await registry.invoke("jev.typed", input, policy)).result.status).toBe("failed");
		answers.c1 = { type: "noul", noul: 1.1 };
		expect((await registry.invoke("jev.typed", input, policy)).result.status).toBe("failed");
	});
	it("does not call transport after cancellation", async () => {
		let calls = 0;
		const implementation = createJevImplementation(
			new TypeSafeClient({
				apiKey: "test",
				fetch: async () => {
					calls++;
					throw new Error("unexpected");
				},
			}),
		);
		const controller = new AbortController();
		controller.abort();
		expect(await implementation.evaluate(request, policy, controller.signal)).toMatchObject({
			status: "failed",
			reason: "aborted",
		});
		expect(calls).toBe(0);
		expect(() => implementation.validatePolicy?.({ instructions: "x", minProbability: 2 })).toThrow();
	});
});
