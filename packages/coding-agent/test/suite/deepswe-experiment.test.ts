import { readFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DecisionRegistry, type DecisionRequest } from "@earendil-works/pi-decisions";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createLlmDecisions } from "../../examples/deepswe/llm-decisions.ts";
import { type Experiment, runExperiment, settingsForArm } from "../../examples/deepswe/run.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import * as jevClient from "../../src/jev/client.ts";
import { createConfiguredDecisionExtension } from "../../src/jev/decision-runtime.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	harness?.cleanup();
});
const policy = {
	instructions: "Select useful evidence",
	minProbability: 0.7,
	criteria: { true: "Useful", false: "Redundant" },
};
const request: DecisionRequest = {
	definition: "generation.route/v1",
	boundaryId: "phase1",
	stateRevision: "r1",
	features: { history: ["keep"] },
	candidates: [
		{ id: "keep", description: "Keep current", attributes: {} },
		{ id: "cheap", description: "Cheaper", attributes: {} },
	],
};

it.each([
	["generation.route/v1", '{"c0":0.1,"c1":0.9}', "proposed", { kind: "select", candidateId: "cheap" }],
	["generation.route/v1", '{"c0":0.5,"c1":0.5}', "abstained", undefined],
	["generation.route/v1", '{"c0":0.9,"c1":0.9}', "failed", undefined],
	["generation.route/v1", '{"c0":0.1,"unknown":0.9}', "failed", undefined],
	["generation.route/v1", "not json", "failed", undefined],
	["output.select/v1", '{"c0":0.1,"c1":0.5}', "proposed", { kind: "subset", candidateIds: ["cheap"] }],
	["context.retention/v1", '{"c0":0.1,"c1":0.5}', "proposed", { kind: "score", values: { keep: 0.1, cheap: 0.5 } }],
])("validates LLM comparator %s / %s", async (definition, response, status, answer) => {
	harness = await createHarness();
	harness.setResponses([fauxAssistantMessage(response)]);
	const registry = new DecisionRegistry();
	registry.register(
		createLlmDecisions(new ModelRegistry(harness.session.modelRuntime), harness.getModel(), "off", 1024),
	);
	const invocation = await registry.invoke("experiment.llm", { ...request, definition }, policy);
	expect(invocation.result.status).toBe(status);
	if (invocation.result.status === "proposed") expect(invocation.result.answer).toEqual(answer);
	expect(invocation.requestCount).toBe(1);
	expect(invocation.costUsd).not.toBeNull();
	if (status !== "failed") expect(Object.keys(invocation.result.scores ?? {})).toEqual(["keep", "cheap"]);
});

it("does not send cancelled or single-outcome requests", async () => {
	harness = await createHarness();
	const registry = new DecisionRegistry();
	registry.register(
		createLlmDecisions(new ModelRegistry(harness.session.modelRuntime), harness.getModel(), "off", 1024),
	);
	const single = await registry.invoke(
		"experiment.llm",
		{ ...request, candidates: request.candidates.slice(0, 1) },
		policy,
	);
	expect(single.requestCount).toBe(0);
	const cancelled = await registry.invoke("experiment.llm", request, policy, { signal: AbortSignal.abort() });
	expect(cancelled.result.status).toBe("abstained");
	expect(harness.faux.state.callCount).toBe(0);
});

it("changes only implementations between arms and validates the complete manifest offline", async () => {
	const config = JSON.parse(
		readFileSync(new URL("../../examples/deepswe/experiment.json", import.meta.url), "utf8"),
	) as Experiment;
	const llm = settingsForArm(config.decisions, "llm");
	expect(config.routingEnabled).toBe(true);
	expect(config.decisions.routing?.escalationMaxUsd).toBe(0.25);
	expect(JSON.stringify(llm).replaceAll("experiment.llm", "jev.typed")).toBe(JSON.stringify(config.decisions));
	expect(settingsForArm(config.decisions, "jev")).toEqual(config.decisions);
	expect(() => settingsForArm(config.decisions, "typo")).toThrow();
	harness = await createHarness();
	const implementation = createLlmDecisions(
		new ModelRegistry(harness.session.modelRuntime),
		harness.getModel(),
		"off",
		1024,
	);
	let failure: unknown;
	createConfiguredDecisionExtension(llm, {
		implementations: [implementation],
		onError: (error) => {
			failure = error;
		},
	});
	expect(failure).toBeUndefined();
	const modelsPath = `${harness.tempDir}/models.json`;
	// ModelRuntime's actual parser, no provider calls or catalog refresh.
	writeFileSync(modelsPath, JSON.stringify(config.models));
	const runtime = await ModelRuntime.create({
		modelsPath,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	expect(runtime.getModel("meta", "muse-spark-1.3")?.thinkingLevelMap?.xhigh).toBe("xhigh");
});

it.each([
	["llm", 0.25],
	["jev", 0.25],
	["llm", 0],
	["jev", 0],
] as const)("%s routing respects phase boundaries and cap %s", async (arm, cap) => {
	const config = JSON.parse(
		readFileSync(new URL("../../examples/deepswe/experiment.json", import.meta.url), "utf8"),
	) as Experiment;
	const routing = settingsForArm(config.decisions, arm).routing!;
	routing.escalationMaxUsd = cap;
	routing.requiredTools = ["step"];
	routing.routes = routing.routes.map((route) => ({
		...route,
		provider: "faux",
		model: route.id.startsWith("spark12") ? "second" : "first",
		tools: ["step"],
	}));
	const observed: DecisionRequest[] = [];
	const replayEvents: Record<string, unknown>[] = [];
	let phaseCalls = 0;
	let routeCalls = 0;
	const extension = createConfiguredDecisionExtension(
		{ routing },
		{
			onTrace: (event) => replayEvents.push(event),
			implementations: [
				{
					id: arm === "llm" ? "experiment.llm" : "jev.typed",
					version: "fixture",
					definitions: ["generation.route/v1", "generation.phase/v1"],
					async evaluate(input) {
						observed.push(input);
						const selected =
							input.definition === "generation.phase/v1"
								? ++phaseCalls === 1
									? "investigate"
									: "implement"
								: ++routeCalls === 1
									? "spark13-low"
									: "spark12-high";
						return {
							status: "proposed",
							answer: { kind: "select", candidateId: selected },
							usage: { requests: 0 },
						};
					},
				},
			],
		},
	);
	harness = await createHarness({
		models: ["first", "second"].map((id) => ({
			id,
			reasoning: true,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		})),
		extensionFactories: [
			extension,
			(pi) => {
				pi.registerTool({
					name: "step",
					label: "Step",
					description: "Offline step",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "Evidence" }], details: {} }),
				});
			},
		],
	});
	// Faux supports high, not xhigh; real Muse's xhigh mapping is checked above.
	harness.session.setThinkingLevel("high");
	harness.setResponses([
		() => {
			expect(harness!.session.thinkingLevel).toBe(cap ? "low" : "high");
			return fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" });
		},
		() => {
			expect(routeCalls).toBe(1);
			expect(harness!.session.thinkingLevel).toBe(cap ? "low" : "high");
			return fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" });
		},
		() => {
			expect(harness!.session.model?.id).toBe(cap ? "second" : "first");
			expect(harness!.session.thinkingLevel).toBe("high");
			return fauxAssistantMessage("Done");
		},
	]);
	await harness.session.prompt("Inspect, implement and verify");
	expect(routeCalls).toBe(2);
	expect(observed.filter((value) => value.definition === "generation.route/v1")[1].features.history).not.toEqual([]);
	const traces = harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "decision-route" ? [entry.data] : []));
	expect(traces).toHaveLength(2);
	for (const trace of traces)
		expect(trace).toMatchObject(cap ? { admission: "capability" } : { fallback: "switch-cost" });
	expect(replayEvents.filter((event) => event.event === "start")).toHaveLength(4);
	expect(replayEvents.filter((event) => event.event === "outcome")).toHaveLength(4);
	for (const event of replayEvents.filter((event) => event.event === "start")) {
		expect(replayEvents.filter((other) => other.event === "end" && other.traceId === event.traceId)).toHaveLength(1);
		expect(replayEvents.filter((other) => other.event === "outcome" && other.traceId === event.traceId)).toHaveLength(
			1,
		);
	}
	expect(replayEvents.filter((event) => event.event === "outcome" && event.admissionInputs)).toHaveLength(2);
});

it.each(["llm", "jev"])("runs a complete offline %s session and captures replayable decisions", async (arm) => {
	harness = await createHarness();
	const model = harness.getModel();
	vi.spyOn(ModelRuntime, "create").mockResolvedValue(harness.session.modelRuntime);
	harness.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage('{"c0":1,"c1":0,"c2":0}')]);
	vi.stubEnv("TYPESAFE_API_KEY", "offline-test");
	vi.spyOn(jevClient, "createJevClient").mockReturnValue(
		new TypeSafeClient({
			apiKey: "offline-test",
			fetch: async () =>
				Response.json({
					model: "fixture",
					usage: { input_tokens: 10, output_tokens: 2 },
					answers: {
						selection: { type: "choice", choice: "c0", confidence: 1, probabilities: { c0: 1, c1: 0, c2: 0 } },
					},
				}),
		}),
	);
	const output = `${harness.tempDir}/evaluation`;
	await runExperiment(
		{
			generator: { provider: model.provider, model: model.id, effort: "off" },
			controller: { provider: model.provider, model: model.id, effort: "off", maxTokens: 1024 },
			models: { providers: {} },
			routingEnabled: false,
			allowContributorDataUse: false,
			maxTurns: 10,
			decisions: {
				components: { completion: { maxPasses: 1 } },
				bindings: { "completion.verify/v1": { implementation: "jev.typed", policy } },
			},
		},
		arm,
		"Offline fixture; no tools necessary",
		output,
	);
	const summary = JSON.parse(readFileSync(`${output}/summary.json`, "utf8"));
	expect(summary.decisionCalls).toBe(1);
	expect(summary.unknownDecisionCosts).toBe(arm === "llm" ? 0 : 1);
	expect(summary.failed).toBe(false);
	expect(summary.pendingProviderTraceIds).toEqual([]);
	expect(summary.missingOutcomeTraceIds).toEqual([]);
	expect(readFileSync(`${output}/decisions.jsonl`, "utf8")).toContain("completion.verify/v1");
	const events = readFileSync(`${output}/decisions.jsonl`, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(events.map((event) => event.event)).toEqual(["start", "provider_result", "end", "outcome"]);
	expect(new Set(events.map((event) => event.traceId)).size).toBe(1);
	expect(events[0].request.candidates.map((candidate: { id: string }) => candidate.id)).toEqual([
		"accept",
		"verify",
		"clarify",
	]);
	expect(events[0].policy).toEqual(policy);
	expect(events[1].scores).toEqual({ accept: 1, verify: 0, clarify: 0 });
	expect(events[3].effectiveAction).toBe("accept");
});
