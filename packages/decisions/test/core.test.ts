import { describe, expect, it } from "vitest";
import {
	DecisionRegistry,
	type DecisionRequest,
	digestJson,
	heuristicImplementation,
	keepCurrentImplementation,
	type PolicyArtifact,
	PolicyStore,
	recordedImplementation,
} from "../src/index.ts";

const request: DecisionRequest = {
	definition: "generation.route/v1",
	boundaryId: "phase-1",
	stateRevision: "1",
	features: { pending: false },
	currentCandidateId: "a",
	candidates: [
		{ id: "a", description: "A", attributes: { price: 2 } },
		{ id: "b", description: "B", attributes: { price: 1 } },
	],
};

const artifact: PolicyArtifact = {
	schemaVersion: 1,
	id: "team/router",
	version: "1",
	definition: request.definition,
	implementation: "heuristic.weighted",
	projectionVersion: "1",
	policy: { weights: { price: -1 } },
};

describe("bounded decisions", () => {
	it("keeps all context evidence in the no-inference baseline", async () => {
		const registry = new DecisionRegistry();
		registry.register(keepCurrentImplementation);
		const result = await registry.invoke("baseline.keep-current", { ...request, definition: "context.retention/v1" });
		expect(result.result).toMatchObject({ status: "proposed", answer: { kind: "score", values: { a: 1, b: 1 } } });
		expect(result.requestCount).toBe(0);
		expect(result.costUsd).toBe(0);
	});
	it("requires complete bounded context retention scores from every implementation", async () => {
		const invalidScores: Record<string, number>[] = [
			{ a: 0.5 },
			{ a: 0.5, b: -0.1 },
			{ a: 0.5, b: 1.1 },
			{ a: 0.5, b: NaN },
		];
		for (const values of invalidScores) {
			const registry = new DecisionRegistry();
			registry.register(
				recordedImplementation("scores", {
					"phase-1": { status: "proposed", answer: { kind: "score", values } },
				}),
			);
			expect(
				(await registry.invoke("scores", { ...request, definition: "context.retention/v1" })).result.status,
			).toBe("failed");
		}
		const registry = new DecisionRegistry();
		registry.register(
			recordedImplementation("scores", {
				"phase-1": { status: "proposed", answer: { kind: "score", values: { a: 0, b: 1 } } },
			}),
		);
		expect((await registry.invoke("scores", { ...request, definition: "context.retention/v1" })).result.status).toBe(
			"proposed",
		);
	});
	it("captures input before yielding and rejects sparse JSON arrays", async () => {
		const input = structuredClone(request);
		const registry = new DecisionRegistry();
		registry.register({
			...keepCurrentImplementation,
			async evaluate(snapshot) {
				expect(snapshot.features.pending).toBe(false);
				return { status: "proposed", answer: { kind: "select", candidateId: "a" } };
			},
		});
		const digest = digestJson(input);
		const pending = registry.invoke("baseline.keep-current", input);
		input.features = { pending: true };
		expect((await pending).inputDigest).toBe(digest);
		expect(() => digestJson(Array(1))).toThrow();
	});
	it("bounds serialized input and rejects malformed state before invoking plugins", async () => {
		let calls = 0;
		const registry = new DecisionRegistry();
		registry.register({
			...keepCurrentImplementation,
			async evaluate() {
				calls++;
				return { status: "abstained", reason: "unused" };
			},
		});
		expect((await registry.invoke("baseline.keep-current", request, {}, { maxInputBytes: 1 })).result).toEqual({
			status: "failed",
			reason: "invalid-input",
		});
		expect(
			(await registry.invoke("baseline.keep-current", { ...request, features: [] } as unknown as DecisionRequest))
				.result.status,
		).toBe("failed");
		const controller = new AbortController();
		const invocation = registry.invoke("baseline.keep-current", request, {}, { signal: controller.signal });
		controller.abort();
		expect((await invocation).result.status).toBe("abstained");
		expect(calls).toBe(0);
	});
	it("runs interchangeable implementations against the same request", async () => {
		const registry = new DecisionRegistry();
		registry.register(keepCurrentImplementation);
		registry.register(heuristicImplementation);
		registry.register(
			recordedImplementation("recorded", {
				"phase-1": { status: "proposed", answer: { kind: "select", candidateId: "b" } },
			}),
		);
		const baseline = await registry.invoke("baseline.keep-current", request);
		const heuristic = await registry.invoke("heuristic.weighted", request, artifact.policy);
		const replay = await registry.invoke("recorded", request);
		expect(baseline.result).toMatchObject({ status: "proposed", answer: { candidateId: "a" } });
		expect(heuristic.result).toMatchObject({ status: "proposed", answer: { candidateId: "b" } });
		expect(replay.result).toMatchObject({ status: "proposed", answer: { candidateId: "b" } });
		expect(baseline.inputDigest).toBe(heuristic.inputDigest);
		expect(baseline.requestCount).toBe(0);
		expect(replay.costUsd).toBeNull();
	});

	it("rejects invalid answers and isolates plugin mutation", async () => {
		const registry = new DecisionRegistry();
		registry.register({
			...keepCurrentImplementation,
			id: "bad",
			async evaluate(input) {
				(input.features as Record<string, boolean>).pending = true;
				return { status: "proposed", answer: { kind: "select", candidateId: "unknown" } };
			},
		});
		expect((await registry.invoke("bad", request)).result).toEqual({ status: "failed", reason: "invalid-answer" });
		expect(request.features.pending).toBe(false);
		expect(() => registry.register(keepCurrentImplementation)).not.toThrow();
		expect(() => registry.register(keepCurrentImplementation)).toThrow("duplicate");
	});

	it("enforces cancellation, deadline, and shared invocation budget", async () => {
		let calls = 0;
		const registry = new DecisionRegistry();
		registry.register({
			...keepCurrentImplementation,
			id: "slow",
			async evaluate() {
				calls++;
				return new Promise(() => {});
			},
		});
		const controller = new AbortController();
		controller.abort();
		expect((await registry.invoke("slow", request, {}, { signal: controller.signal })).result.status).toBe(
			"abstained",
		);
		expect(calls).toBe(0);
		const budget = { remaining: 1 };
		expect((await registry.invoke("slow", request, {}, { budget, timeoutMs: 2 })).result).toEqual({
			status: "failed",
			reason: "timeout",
		});
		expect((await registry.invoke("slow", request, {}, { budget })).result).toEqual({
			status: "abstained",
			reason: "budget-exhausted",
		});
		expect(calls).toBe(1);
	});

	it("rejects unknown cost for a finite cap and canonicalizes key order", async () => {
		const registry = new DecisionRegistry();
		registry.register(
			recordedImplementation("replay", {
				"phase-1": { status: "proposed", answer: { kind: "select", candidateId: "a" } },
			}),
		);
		expect((await registry.invoke("replay", request, {}, { maxCostUsd: 1 })).result).toEqual({
			status: "abstained",
			reason: "cost-limit",
		});
		expect(digestJson({ a: 1, b: 2 })).toBe(digestJson({ b: 2, a: 1 }));
		expect(() => digestJson({ value: NaN })).toThrow();
	});
});

describe("policy activation", () => {
	it("enforces operator digest pins after restart without replacing the valid configuration", () => {
		const digest = digestJson(artifact);
		const pins = { "team/router@1": digest };
		const restarted = new PolicyStore(undefined, pins);
		pins["team/router@1"] = "0".repeat(64);
		restarted.activate([artifact]);
		expect(() => restarted.activate([{ ...artifact, policy: { weights: { price: 1 } } }])).toThrow("mutated");
		expect(restarted.get("team/router@1")?.digest).toBe(digest);
		expect(() => new PolicyStore(undefined, { "team/router@1": "invalid" })).toThrow("digest pin");
	});

	it("changes behavior through data and rejects the whole invalid update", async () => {
		const registry = new DecisionRegistry();
		registry.register(heuristicImplementation);
		const store = new PolicyStore((value) =>
			registry.validatePolicy(value.implementation, value.definition, value.policy),
		);
		store.activate([artifact]);
		const original = store.get("team/router@1")!;
		expect(() =>
			store.activate([
				{ ...artifact, version: "2" },
				{ ...artifact, version: "3", unknown: true },
			]),
		).toThrow();
		expect(store.get("team/router@1")).toEqual(original);
		expect(store.get("team/router@2")).toBeUndefined();
		expect(() => store.activate([{ ...artifact, policy: { weights: { price: 1 } } }])).toThrow("mutated");
		store.activate([{ ...artifact, version: "2", policy: { weights: { price: 1 } } }]);
		expect(
			(await registry.invoke("heuristic.weighted", request, store.get("team/router@2")!.artifact.policy)).result,
		).toMatchObject({ answer: { candidateId: "a" } });
		store.activate([artifact]);
		expect(store.get("team/router@1")!.digest).toBe(original.digest);
	});
});
