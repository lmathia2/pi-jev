import { BACKGROUND_CONTEXT, type LaneConfiguration, withAbortSignal } from "@earendil-works/pi-agent-core";
import {
	DecisionRegistry,
	type DecisionRequest,
	digestJson,
	type ResolvedPolicy,
	recordedImplementation,
} from "@earendil-works/pi-decisions";
import { describe, expect, it } from "vitest";
import { createDecisionGenerationRouter } from "../src/jev/decision-durable.ts";

const base: LaneConfiguration = {
	model: { provider: "test", modelId: "standard" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
};
const selected: LaneConfiguration = {
	model: { provider: "test", modelId: "deep" },
	thinkingLevel: "high",
	activeToolNames: ["read", "edit"],
};
const request: DecisionRequest = {
	definition: "generation.route/v1",
	boundaryId: "phase-1",
	stateRevision: "revision-1",
	features: { pendingInput: false, cacheReadTokens: 1000 },
	candidates: [{ id: "deep-high", description: "Deep model with high effort", attributes: {} }],
};
const artifact: ResolvedPolicy["artifact"] = {
	schemaVersion: 1,
	id: "test",
	version: "1",
	definition: "generation.route/v1",
	implementation: "fixture",
	projectionVersion: "1",
	policy: {},
};
const policy: ResolvedPolicy = { artifact, digest: digestJson(artifact) };
const event = { lane: "main", runId: "run", configuration: base, messages: [], attempt: 1 };

describe("durable decision adapter", () => {
	it("selects a complete configured model-effort pair from private host state", async () => {
		const registry = new DecisionRegistry();
		registry.register(
			recordedImplementation("fixture", {
				"phase-1": { status: "proposed", answer: { kind: "select", candidateId: "deep-high" } },
			}),
		);
		let admitted = 0;
		const route = createDecisionGenerationRouter({
			registry,
			policy,
			routes: { "deep-high": selected },
			buildRequest: () => request,
			admit: (snapshot) => {
				admitted++;
				return snapshot.features.cacheReadTokens === 1000;
			},
		});
		expect(await route(event, BACKGROUND_CONTEXT)).toEqual({ configuration: selected });
		expect(admitted).toBe(1);
		expect(event.configuration).toEqual(base);
		expect(await route({ ...event, attempt: 2 }, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(admitted).toBe(1);
	});

	it("retains configuration when phase is unchanged or live admission rejects stale state", async () => {
		const registry = new DecisionRegistry();
		registry.register(
			recordedImplementation("fixture", {
				"phase-1": { status: "proposed", answer: { kind: "select", candidateId: "deep-high" } },
			}),
		);
		const options = { registry, policy, routes: { "deep-high": selected }, admit: () => false };
		expect(
			await createDecisionGenerationRouter({ ...options, buildRequest: () => undefined })(event, BACKGROUND_CONTEXT),
		).toBeUndefined();
		expect(
			await createDecisionGenerationRouter({ ...options, buildRequest: () => request })(event, BACKGROUND_CONTEXT),
		).toBeUndefined();
	});

	it("cannot return a route after cancellation during admission", async () => {
		const registry = new DecisionRegistry();
		registry.register(
			recordedImplementation("fixture", {
				"phase-1": { status: "proposed", answer: { kind: "select", candidateId: "deep-high" } },
			}),
		);
		const controller = new AbortController();
		const route = createDecisionGenerationRouter({
			registry,
			policy,
			routes: { "deep-high": selected },
			buildRequest: () => request,
			admit: () => {
				controller.abort();
				return true;
			},
		});
		expect(await route(event, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).toBeUndefined();
	});
});
