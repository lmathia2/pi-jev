import { expect, it } from "vitest";
import type { DecisionRequest, DecisionResult } from "../src/contracts.ts";
import { DecisionRegistry, digestJson } from "../src/registry.ts";

const request: DecisionRequest = {
	definition: "generation.route/v1",
	boundaryId: "phase",
	stateRevision: "revision",
	features: { history: [{ selected: "a" }] },
	candidates: ["a", "b"].map((id) => ({ id, description: id, attributes: { effort: "high" } })),
};
const policy = { minProbability: 0.7 };
const result: DecisionResult = {
	status: "proposed",
	answer: { kind: "select", candidateId: "b" },
	scores: { a: 0.1, b: 0.9 },
	usage: { requests: 1 },
};

it("captures immutable replay inputs, every score, and reproduces the admitted answer offline", async () => {
	const events: Record<string, unknown>[] = [];
	const registry = new DecisionRegistry(undefined, (event) => events.push(event));
	registry.register({
		id: "fixture",
		version: "1",
		definitions: [request.definition],
		async evaluate(input) {
			(input.features as Record<string, unknown>).history = [];
			return result;
		},
	});
	const original = await registry.invoke("fixture", request, policy);
	const serialized = events.map((event) => JSON.parse(JSON.stringify(event)));
	expect(serialized.map((event) => event.event)).toEqual(["start", "provider_result", "end"]);
	const start = serialized[0];
	expect(start.request).toEqual(request);
	expect(start.policy).toEqual(policy);
	expect(digestJson(start.request)).toBe(start.inputDigest);
	expect(digestJson(start.policy)).toBe(start.policyDigest);
	expect(serialized[1].scores).toEqual({ a: 0.1, b: 0.9 });
	expect(new Set(serialized.map((event) => event.traceId)).size).toBe(1);
	const replay = new DecisionRegistry();
	replay.register({
		id: start.implementation,
		version: start.version,
		definitions: [start.request.definition],
		async evaluate() {
			return serialized[1].result;
		},
	});
	expect((await replay.invoke(start.implementation, start.request, start.policy)).result).toEqual(original.result);
});

it.each(["budget", "cancelled", "throw", "timeout"])(
	"records a terminal decision and unavailable scores for %s",
	async (mode) => {
		const events: Record<string, unknown>[] = [];
		const registry = new DecisionRegistry(undefined, (event) => events.push(event));
		registry.register({
			id: "fixture",
			version: "1",
			definitions: [request.definition],
			async evaluate() {
				if (mode === "throw") throw new Error("private provider error");
				return new Promise<DecisionResult>(() => {});
			},
		});
		await registry.invoke("fixture", request, policy, {
			timeoutMs: 5,
			...(mode === "budget" ? { budget: { remaining: 0 } } : {}),
			...(mode === "cancelled" ? { signal: AbortSignal.abort() } : {}),
		});
		expect(events.filter((event) => event.event === "end")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			event: "end",
			scores: { a: null, b: null },
			scoresUnavailableReason: {
				budget: "budget-exhausted",
				cancelled: "cancelled",
				throw: "implementation-error",
				timeout: "timeout",
			}[mode],
		});
		expect(JSON.stringify(events)).not.toContain("private provider error");
	},
);

it("keeps a late provider result separate from the terminal timeout", async () => {
	const events: Record<string, unknown>[] = [];
	let finish!: (value: DecisionResult) => void;
	const registry = new DecisionRegistry(undefined, (event) => events.push(event));
	registry.register({
		id: "fixture",
		version: "1",
		definitions: [request.definition],
		evaluate: () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	});
	await registry.invoke("fixture", request, policy, { timeoutMs: 5 });
	finish(result);
	await Promise.resolve();
	expect(events.map((event) => event.event)).toEqual(["start", "end", "provider_result"]);
	expect(events.at(-1)).toMatchObject({ afterAbort: true, scores: result.scores });
});
