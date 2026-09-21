import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { type DecisionImplementation, type DecisionResult, digestJson, type Json } from "@earendil-works/pi-decisions";
import { createJevImplementation } from "@earendil-works/pi-decisions/jev";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createJevClient } from "../../src/jev/client.ts";
import { createConfiguredDecisionExtension, type DecisionSettings } from "../../src/jev/decision-runtime.ts";
import { createLlmDecisions } from "./llm-decisions.ts";

export interface Experiment {
	generator: { provider: string; model: string; effort: ThinkingLevel };
	controller: { provider: string; model: string; effort: ThinkingLevel; maxTokens: number };
	maxTurns: number;
	models: Json;
	routingEnabled: boolean;
	allowContributorDataUse: boolean;
	decisions: DecisionSettings;
}

/** Change implementation IDs only. Rubrics, candidate projections and host guards stay identical. */
export function settingsForArm(config: DecisionSettings, arm: string): DecisionSettings {
	if (!["llm", "jev", "control"].includes(arm)) throw new Error("Arm must be llm, jev or control");
	const settings = structuredClone(config);
	if (settings.policyPackages?.length || Object.keys(settings.policyReferences ?? {}).length)
		throw new Error("Experiment uses explicit inline policies, not external policy overrides");
	const bindings = [
		...Object.values(settings.bindings ?? {}),
		...(settings.routing
			? [settings.routing.binding, ...(settings.routing.phaseBinding ? [settings.routing.phaseBinding] : [])]
			: []),
	];
	for (const binding of bindings) {
		if (binding.implementation !== "jev.typed") throw new Error("Experiment seed bindings must use jev.typed");
		binding.implementation = arm === "llm" ? "experiment.llm" : "jev.typed";
	}
	return settings;
}

export async function runExperiment(
	config: Experiment,
	arm: string,
	instruction: string,
	output: string,
): Promise<void> {
	// This standalone SDK runner bypasses Pi CLI setup. Honor Pier's egress proxy for both providers.
	configureHttpDispatcher();
	const decisions = settingsForArm(config.decisions, arm);
	if (typeof config.routingEnabled !== "boolean" || typeof config.allowContributorDataUse !== "boolean")
		throw new Error("Explicit routingEnabled and allowContributorDataUse required");
	if (config.routingEnabled && !decisions.routing) throw new Error("routingEnabled requires routing configuration");
	if (!config.routingEnabled || arm === "control") delete decisions.routing;
	const usedModels = [
		config.generator,
		...(arm === "llm" ? [config.controller] : []),
		...(decisions.routing?.routes ?? []),
	];
	if (!config.allowContributorDataUse && usedModels.some(({ model }) => model.includes("contributor")))
		throw new Error(
			"Contributor models permit provider training; explicitly set allowContributorDataUse after review",
		);
	if (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 10000)
		throw new Error("maxTurns must be 1..10000");
	mkdirSync(output, { recursive: true });
	if (
		["experiment.json", "decisions.jsonl", "events.jsonl", "sessions"].some((name) =>
			existsSync(resolve(output, name)),
		)
	)
		throw new Error("Experiment output directory already contains a run");
	const agentDir = resolve(output, "config");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(resolve(agentDir, "models.json"), JSON.stringify(config.models));
	const runtime = await ModelRuntime.create({
		authPath: resolve(agentDir, "auth.json"),
		modelsPath: resolve(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const model = runtime.getModel(config.generator.provider, config.generator.model);
	if (
		!model ||
		!runtime.hasConfiguredAuth(model.provider) ||
		!getSupportedThinkingLevels(model).includes(config.generator.effort)
	)
		throw new Error("Generator model, authentication or effort unavailable");
	for (const route of decisions.routing?.routes ?? []) {
		const candidate = runtime.getModel(route.provider, route.model);
		if (
			!candidate ||
			!runtime.hasConfiguredAuth(candidate.provider) ||
			!getSupportedThinkingLevels(candidate).includes(route.effort)
		)
			throw new Error(`Unavailable configured route: ${route.id}`);
	}
	let implementation: DecisionImplementation | undefined;
	if (arm === "llm") {
		const controller = runtime.getModel(config.controller.provider, config.controller.model);
		if (!controller || !runtime.hasConfiguredAuth(controller.provider)) throw new Error("Controller unavailable");
		implementation = createLlmDecisions(
			new ModelRegistry(runtime),
			controller,
			config.controller.effort,
			config.controller.maxTokens,
		);
	} else if (arm === "jev") {
		const apiKey = process.env.TYPESAFE_API_KEY;
		if (!apiKey) throw new Error("TYPESAFE_API_KEY required for Jev arm");
		implementation = createJevImplementation(createJevClient({ apiKey, timeoutMs: decisions.timeoutMs ?? 30000 }));
	}
	let decisionCalls = 0;
	let knownDecisionCost = 0;
	let unknownDecisionCosts = 0;
	let traceWriteFailed = false;
	const pendingProviders = new Set<unknown>();
	const pendingOutcomes = new Set<unknown>();
	let configurationError: unknown;
	const extension = createConfiguredDecisionExtension(decisions, {
		implementations: implementation ? [implementation] : [],
		onTrace(event) {
			if (event.event === "start") {
				decisionCalls++;
				unknownDecisionCosts++;
				pendingProviders.add(event.traceId);
				pendingOutcomes.add(event.traceId);
			}
			if (event.event === "provider_result") {
				const result = event.result as DecisionResult;
				if (result.usage?.requests === 0 || result.usage?.costUsd !== undefined) unknownDecisionCosts--;
				knownDecisionCost += result.usage?.costUsd ?? 0;
				pendingProviders.delete(event.traceId);
			}
			if (event.event === "provider_error") pendingProviders.delete(event.traceId);
			if (event.event === "outcome") pendingOutcomes.delete(event.traceId);
			if (event.event === "end" && event.started === false && pendingProviders.has(event.traceId)) {
				unknownDecisionCosts--;
				pendingProviders.delete(event.traceId);
			}
			try {
				appendFileSync(resolve(output, "decisions.jsonl"), `${JSON.stringify({ arm, ...event })}\n`, {
					mode: 0o600,
				});
			} catch {
				traceWriteFailed = true;
			}
		},
		onError: (error) => {
			configurationError = error;
		},
	});
	if (arm !== "control" && configurationError) throw configurationError;
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } } });
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		extensionFactories: arm === "control" ? [] : [extension],
		appendSystemPrompt: [
			"Complete the task autonomously using repository tests. Commit your changes before finishing; the benchmark verifier collects committed changes. Never access benchmark verifier files or reference solutions.",
		],
	});
	await loader.reload();
	if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
	const manager = SessionManager.create(process.cwd(), resolve(output, "sessions"));
	const { session } = await createAgentSession({
		modelRuntime: runtime,
		model,
		thinkingLevel: config.generator.effort,
		agentDir,
		resourceLoader: loader,
		settingsManager,
		sessionManager: manager,
		// Extension recall tools are enabled by default; do not accidentally exclude them with an allowlist.
	});
	await session.bindExtensions({});
	session.setActiveToolsByName([...session.getActiveToolNames(), "grep", "find", "ls"]);
	let turns = 0;
	let capped = false;
	let failed = false;
	const started = performance.now();
	writeFileSync(
		resolve(output, "experiment.json"),
		JSON.stringify({ arm, config, configDigest: digestJson(config), node: process.version }, null, 2),
	);
	session.subscribe((event) => {
		appendFileSync(resolve(output, "events.jsonl"), `${JSON.stringify(event)}\n`);
		if (event.type === "turn_end" && ++turns >= config.maxTurns) {
			capped = true;
			void session.abort();
		}
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			["error", "aborted"].includes(event.message.stopReason)
		)
			failed = true;
	});
	try {
		await session.prompt(instruction);
		await session.waitForIdle();
		if (traceWriteFailed) throw new Error("Decision trace write failed; trial is incomplete");
		if (pendingOutcomes.size) throw new Error("Decision host outcome missing; trial is incomplete");
		if (capped || failed) throw new Error(capped ? "Generation turn limit reached" : "Generator failed or aborted");
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		manager.flush();
		writeFileSync(
			resolve(output, "summary.json"),
			JSON.stringify(
				{
					arm,
					elapsedMs: performance.now() - started,
					turns,
					capped,
					failed,
					traceWriteFailed,
					pendingProviderTraceIds: [...pendingProviders],
					missingOutcomeTraceIds: [...pendingOutcomes],
					generator: session.getSessionStats(),
					decisionCalls,
					knownDecisionCostUsd: knownDecisionCost,
					unknownDecisionCosts,
					routing: {
						enabled: Boolean(decisions.routing),
						records: manager
							.getBranch()
							.flatMap((entry) =>
								entry.type === "custom" && ["decision-route", "decision-phase-check"].includes(entry.customType)
									? [{ type: entry.customType, data: entry.data }]
									: [],
							),
					},
					// Persisted summaries are included; interrupted/unreported provider requests may not be.
					costCoverage: "persisted-session-usage-and-completed-decisions",
				},
				null,
				2,
			),
		);
		session.dispose();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [configPath, arm, instructionPath, outputPath] = process.argv.slice(2);
	if (!configPath || !arm || !instructionPath || !outputPath)
		throw new Error("Usage: run.ts CONFIG ARM INSTRUCTION_FILE OUTPUT_DIR");
	await runExperiment(
		JSON.parse(readFileSync(configPath, "utf8")) as Experiment,
		arm,
		readFileSync(instructionPath, "utf8"),
		resolve(outputPath),
	);
}
