import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
	type DecisionInvocation,
	type DecisionRegistry,
	type DecisionRequest,
	digestJson,
	type Json,
} from "@earendil-works/pi-decisions";
import type {
	BeforeGenerationEvent,
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
} from "../core/extensions/types.ts";
import { buildSessionContext } from "../core/session-manager.ts";

export interface DecisionBinding {
	implementation: string;
	policy: Record<string, Json>;
}

/** Complete presets: no inheritance from the previously selected route. */
export interface DecisionRoute {
	id: string;
	description: string;
	provider: string;
	model: string;
	effort: ThinkingLevel;
	tools: string[];
	metrics?: Record<string, number>;
}

export interface DecisionRoutingSettings {
	binding: DecisionBinding;
	routes: DecisionRoute[];
	phases: string[];
	requiredTools: string[];
	timeoutMs: number;
	maxDecisions: number;
	/** Optional classification at newly settled tool-result boundaries. */
	phaseBinding?: DecisionBinding;
	transitions?: Record<string, string[]>;
	phaseDescriptions?: Record<string, string>;
	maxPhaseDecisions?: number;
	/** Approved private-state projection and token estimator calibration. */
	stateLimits?: {
		taskChars?: number;
		recentResults?: number;
		resultChars?: number;
		historyRecords?: number;
		charsPerToken?: number;
	};
	/** Estimated remaining requests/output per phase; calibrated offline, never inferred by token arithmetic in Jev. */
	estimate: {
		requests: number;
		outputTokens: number;
		marginUsd: number;
		decisionCostUsd: number;
		initialPromptTokens?: number;
	};
	/** Capability escalation is opt-in, and still requires a known cost below this cap. */
	escalationMaxUsd?: number;
}

export interface RoutingCostInput {
	promptTokens: number;
	cachedTokens: number;
	requests: number;
	outputTokens: number;
	current: { input: number; cacheRead: number; cacheWrite: number; output: number };
	target: { input: number; cacheRead: number; cacheWrite: number; output: number };
	decisionCostUsd: number;
}

/** Rates are dollars per million tokens. First cold input is charged once, never again as "lost cache". */
export function estimateRoutingCosts(input: RoutingCostInput): { stay: number; switch: number } | undefined {
	const numbers = [
		input.promptTokens,
		input.cachedTokens,
		input.requests,
		input.outputTokens,
		input.decisionCostUsd,
		...Object.values(input.current),
		...Object.values(input.target),
	];
	if (
		numbers.some((value) => !Number.isFinite(value) || value < 0) ||
		input.requests < 1 ||
		input.cachedTokens > input.promptTokens
	)
		return undefined;
	const { promptTokens: prompt, cachedTokens: cached, requests, outputTokens: output, current, target } = input;
	return {
		stay:
			((prompt - cached) * Math.max(current.input, current.cacheWrite) +
				cached * current.cacheRead +
				(requests - 1) * prompt * (current.cacheRead || current.input) +
				output * current.output) /
			1e6,
		// A target write rate of zero means no separate cache-write tariff, not free cold input.
		switch:
			(prompt * Math.max(target.input, target.cacheWrite) +
				// Do not finance a switch with hypothetical future cache hits.
				(requests - 1) * prompt * Math.max(target.input, target.cacheWrite) +
				output * target.output) /
				1e6 +
			input.decisionCostUsd,
	};
}

export function validateDecisionRoutingSettings(value: DecisionRoutingSettings): void {
	digestJson(value);
	if (
		value.stateLimits &&
		Object.entries(value.stateLimits).some(
			([key, limit]) =>
				!["taskChars", "recentResults", "resultChars", "historyRecords", "charsPerToken"].includes(key) ||
				!Number.isFinite(limit) ||
				limit < 1,
		)
	)
		throw new Error("Invalid private-state limits");
	if (
		!value.binding ||
		typeof value.binding.implementation !== "string" ||
		!value.binding.policy ||
		Array.isArray(value.binding.policy)
	)
		throw new Error("Invalid decision binding");
	if (
		!Array.isArray(value.routes) ||
		!value.routes.length ||
		!Array.isArray(value.phases) ||
		!value.phases.length ||
		value.phases.some((phase) => typeof phase !== "string" || !phase) ||
		new Set(value.phases).size !== value.phases.length
	)
		throw new Error("Routes and unique phases are required");
	if (value.phaseBinding) {
		if (
			typeof value.phaseBinding.implementation !== "string" ||
			!value.phaseBinding.policy ||
			Array.isArray(value.phaseBinding.policy) ||
			!value.transitions
		)
			throw new Error("Phase binding requires configured transitions");
		for (const [from, targets] of Object.entries(value.transitions)) {
			if (
				!value.phases.includes(from) ||
				!Array.isArray(targets) ||
				new Set(targets).size !== targets.length ||
				targets.some((target) => !value.phases.includes(target) || target === from)
			)
				throw new Error("Invalid phase transitions");
		}
	}
	if (
		value.phaseDescriptions &&
		Object.entries(value.phaseDescriptions).some(
			([phase, description]) => !value.phases.includes(phase) || typeof description !== "string",
		)
	)
		throw new Error("Invalid phase descriptions");
	if (
		value.maxPhaseDecisions !== undefined &&
		(!Number.isSafeInteger(value.maxPhaseDecisions) || value.maxPhaseDecisions < 0)
	)
		throw new Error("Invalid phase decision limit");
	if (!Array.isArray(value.requiredTools) || value.requiredTools.some((tool) => typeof tool !== "string"))
		throw new Error("Invalid required tools");
	const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"];
	for (const route of value.routes) {
		if (
			!route.id ||
			route.id === "keep_current" ||
			typeof route.description !== "string" ||
			!route.provider ||
			!route.model ||
			!efforts.includes(route.effort) ||
			!Array.isArray(route.tools) ||
			route.tools.some((tool) => typeof tool !== "string") ||
			new Set(route.tools).size !== route.tools.length ||
			value.requiredTools.some((tool) => !route.tools.includes(tool))
		)
			throw new Error("Invalid complete route preset");
		if (
			route.metrics &&
			Object.values(route.metrics).some((number) => typeof number !== "number" || !Number.isFinite(number))
		)
			throw new Error("Invalid route metrics");
	}
	if (new Set(value.routes.map(({ id }) => id)).size !== value.routes.length) throw new Error("Duplicate route ID");
	if (
		!Number.isFinite(value.timeoutMs) ||
		value.timeoutMs <= 0 ||
		!Number.isInteger(value.maxDecisions) ||
		value.maxDecisions < 1 ||
		!value.estimate ||
		!Number.isInteger(value.estimate.requests) ||
		value.estimate.requests < 1 ||
		[
			value.estimate.outputTokens,
			value.estimate.marginUsd,
			value.estimate.decisionCostUsd,
			value.estimate.initialPromptTokens ?? 0,
			value.escalationMaxUsd ?? 0,
		].some((number) => !Number.isFinite(number) || number < 0)
	)
		throw new Error("Invalid decision limits or cost estimates");
}

type RouteTrace = {
	phase: string;
	boundaryId: string;
	policyDigest: string;
	proposal?: string;
	fallback?: string;
	admission?: "unchanged" | "economy" | "capability";
	effective: { provider: string; model: string; effort: string; tools: string[] };
	costs?: { stay: number; switch: number };
	invocation?: Omit<DecisionInvocation, "result">;
};

/** Uses the existing extension runtime for executable plugins. No module paths are interpreted from JSON. */
export function createDecisionRoutingExtension(options: {
	registry: DecisionRegistry;
	settings: DecisionRoutingSettings;
	/** Explicit host-owned phase transition. Never equate a new turn with a new phase. */
	phase?(context: ExtensionContext): string | undefined;
	features?(context: ExtensionContext): Record<string, Json>;
	/** Optional context-manager feasibility floor, estimated before rendering any model-facing prompt. */
	contextRequirements?(context: ExtensionContext): {
		minimumTokens: number;
		fullTokens: number;
		reserveTokens: number;
		safetyMarginTokens: number;
	};
	/** Prepare phase-scoped prompt inputs before estimating route costs. */
	preparePhase?(
		event: BeforeGenerationEvent,
		context: ExtensionContext,
		phaseKey: string,
		pi: ExtensionAPI,
		task: string,
	): Promise<boolean>;
	onRecord?(trace: RouteTrace): void;
}): InlineExtension {
	validateDecisionRoutingSettings(options.settings);
	const settings = structuredClone(options.settings);
	const limits = {
		taskChars: 8000,
		recentResults: 12,
		resultChars: 2000,
		historyRecords: 8,
		charsPerToken: 3,
		...settings.stateLimits,
	};
	return {
		name: "decision-routing",
		hidden: true,
		factory(pi) {
			let task = "";
			const budget = { remaining: settings.maxDecisions };
			const phaseBudget = { remaining: settings.maxPhaseDecisions ?? settings.maxDecisions };
			pi.on("input", (event) => {
				task = event.text;
			});
			pi.on("before_agent_start", (event) => {
				task = event.prompt;
			});
			pi.registerCommand("decision-phase", {
				description: "Select a configured decision phase for the next generation",
				handler: async (argument, context) => {
					if (!context.isIdle()) throw new Error("Phase changes require an idle boundary");
					if (!settings.phases.includes(argument.trim())) throw new Error("Unknown decision phase");
					const entry = [...context.sessionManager.getBranch()]
						.reverse()
						.find((entry) => entry.type === "custom" && entry.customType === "decision-phase");
					const current =
						options.phase?.(context) ??
						(entry?.type === "custom" ? (entry.data as { phase: string }).phase : settings.phases[0]);
					if (current === argument.trim()) return;
					pi.appendEntry("decision-phase", { phase: argument.trim() });
				},
			});
			pi.on("before_generation", async (event, context) => {
				const signal = event.signal;
				let branch = context.sessionManager.getBranch();
				let phaseEntry = [...branch]
					.reverse()
					.find((entry) => entry.type === "custom" && entry.customType === "decision-phase");
				const phaseData = phaseEntry?.type === "custom" ? (phaseEntry.data as { phase?: string }) : undefined;
				let phase = options.phase?.(context) ?? phaseData?.phase ?? settings.phases[0];
				if (!settings.phases.includes(phase) || !context.model || signal?.aborted) return;
				const settled = [...branch]
					.reverse()
					.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
				const phaseChecks = branch.filter(
					(entry) => entry.type === "custom" && entry.customType === "decision-phase-check",
				);
				if (
					!event.initial &&
					!options.phase &&
					settings.phaseBinding &&
					settled &&
					phaseChecks.length < (settings.maxPhaseDecisions ?? settings.maxDecisions) &&
					phaseBudget.remaining > 0 &&
					!phaseChecks.some(
						(entry) =>
							entry.type === "custom" && (entry.data as { settledId?: string })?.settledId === settled.id,
					)
				) {
					const allowed = settings.transitions?.[phase] ?? [];
					if (allowed.length) {
						const phaseRevision = () =>
							digestJson({
								leaf: context.sessionManager.getLeafId(),
								model: context.model?.id ?? null,
								provider: context.model?.provider ?? null,
								effort: pi.getThinkingLevel(),
								tools: pi.getActiveTools(),
								task,
								pending: context.hasPendingMessages(),
							});
						const beforePhase = phaseRevision();
						const phaseInvocation = await options.registry.invoke(
							settings.phaseBinding.implementation,
							{
								definition: "generation.phase/v1",
								boundaryId: `${context.sessionManager.getSessionId()}:${settled.id}`,
								stateRevision: beforePhase,
								currentCandidateId: phase,
								features: {
									...options.features?.(context),
									task: task.slice(0, limits.taskChars),
									phase,
									pendingInput: context.hasPendingMessages(),
									contextTokens: context.getContextUsage()?.tokens ?? null,
									toolResults: branch.slice(-limits.recentResults).flatMap((entry) =>
										entry.type === "message" && entry.message.role === "toolResult"
											? [
													{
														tool: entry.message.toolName,
														error: entry.message.isError,
														text: contentText(entry.message.content, "\n").slice(0, limits.resultChars),
													},
												]
											: [],
									),
									history: phaseChecks
										.slice(-limits.historyRecords)
										.map((entry) =>
											entry.type === "custom" ? { id: entry.id, data: entry.data as Json } : null,
										),
								},
								candidates: [phase, ...allowed].map((id) => ({
									id,
									description: settings.phaseDescriptions?.[id] ?? id,
									attributes: {},
								})),
							},
							settings.phaseBinding.policy,
							{ signal, timeoutMs: settings.timeoutMs, budget: phaseBudget },
						);
						if (signal?.aborted || phaseRevision() !== beforePhase) {
							options.registry.trace({
								event: "outcome",
								traceId: phaseInvocation.traceId,
								effectiveAction: "unchanged",
								fallback: "cancelled_or_stale",
								phase,
							});
							return;
						}
						const answer = phaseInvocation.result;
						const next =
							answer.status === "proposed" && answer.answer.kind === "select"
								? answer.answer.candidateId
								: phase;
						pi.appendEntry("decision-phase-check", {
							settledId: settled.id,
							phase,
							selected: next,
							policyDigest: phaseInvocation.policyDigest,
							inputDigest: phaseInvocation.inputDigest,
							status: answer.status,
						});
						options.registry.trace({
							event: "outcome",
							traceId: phaseInvocation.traceId,
							effectiveAction: next === phase ? "unchanged" : "transition",
							phase,
							selected: next,
							allowed,
						});
						if (next !== phase && allowed.includes(next)) {
							phase = next;
							pi.appendEntry("decision-phase", { phase, policyDigest: phaseInvocation.policyDigest });
							branch = context.sessionManager.getBranch();
							phaseEntry = branch.at(-1);
						}
					}
				}
				const phaseKey = `${phaseEntry?.id ?? "initial"}:${phase}`;
				if ((await options.preparePhase?.(event, context, phaseKey, pi, task)) === false) return;
				if (signal?.aborted) return;
				branch = context.sessionManager.getBranch();
				const records = branch.filter((entry) => entry.type === "custom" && entry.customType === "decision-route");
				const last = records.at(-1);
				const previous = last?.type === "custom" ? (last.data as RouteTrace) : undefined;
				// Branch-local persisted decisions pin model, effort and tool preset across turns/reload.
				if (previous?.phase === phaseKey || records.length >= settings.maxDecisions || budget.remaining <= 0)
					return;
				const currentModel = context.model;
				const effective = () => ({
					provider: context.model?.provider ?? currentModel.provider,
					model: context.model?.id ?? currentModel.id,
					effort: pi.getThinkingLevel(),
					tools: pi.getActiveTools(),
				});
				const pending = [...branch]
					.reverse()
					.find((entry) => entry.type === "custom" && entry.customType === "decision-route-pending");
				if (
					pending?.type === "custom" &&
					(pending.data as { phase?: string })?.phase === phaseKey &&
					(!last || branch.indexOf(pending) > branch.indexOf(last))
				) {
					// A crash can leave only part of a preset persisted. Pin the restored host state;
					// rerunning the same proposal could overwrite intervening user changes.
					pi.appendEntry("decision-route", {
						phase: phaseKey,
						boundaryId: `${context.sessionManager.getSessionId()}:${phaseKey}`,
						policyDigest: digestJson(settings.binding.policy),
						effective: effective(),
						fallback: "apply-interrupted",
					});
					return;
				}
				const revision = () =>
					digestJson({
						leaf: context.sessionManager.getLeafId(),
						...effective(),
						task,
						promptOptions: JSON.stringify(event.systemPromptOptions),
						pending: context.hasPendingMessages(),
					});
				const before = revision();
				const available = new Set(pi.getAllTools().map((tool) => tool.name));
				const authenticated = new Set(
					context.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
				);
				const requirements = options.contextRequirements?.(context);
				const prospectiveOverhead = Math.ceil(
					(JSON.stringify(event.systemPromptOptions).length +
						JSON.stringify(pi.getAllTools()).length +
						task.length) /
						limits.charsPerToken,
				);
				const routes = settings.routes.filter((route) => {
					const model = context.modelRegistry.find(route.provider, route.model);
					// Smaller windows require an active context manager and a feasible required-content floor.
					return (
						model &&
						authenticated.has(`${route.provider}/${route.model}`) &&
						(model.contextWindow >= currentModel.contextWindow ||
							(requirements &&
								model.contextWindow >
									requirements.minimumTokens +
										prospectiveOverhead +
										requirements.safetyMarginTokens +
										Math.max(requirements.reserveTokens, model.maxTokens))) &&
						currentModel.input.every((input) => model.input.includes(input)) &&
						getSupportedThinkingLevels(model).includes(route.effort) &&
						route.tools.every((tool) => available.has(tool)) &&
						(!context.scopedModels.length ||
							context.scopedModels.some(
								(scope) => scope.model.provider === route.provider && scope.model.id === route.model,
							))
					);
				});
				const usage = context.getContextUsage();
				const assistant = [...branch]
					.reverse()
					.find((entry) => entry.type === "message" && entry.message.role === "assistant");
				const measured =
					assistant?.type === "message" && assistant.message.role === "assistant"
						? assistant.message.usage
						: undefined;
				const sameUsageModel =
					assistant?.type === "message" &&
					assistant.message.role === "assistant" &&
					assistant.message.provider === currentModel.provider &&
					assistant.message.model === currentModel.id;
				// Count structured inputs without rendering a model-facing prompt. The optional
				// floor accounts for host prompt material unavailable through this adapter.
				const estimatedPromptTokens = Math.ceil(
					(JSON.stringify(event.systemPromptOptions).length +
						JSON.stringify(buildSessionContext(branch).messages).length +
						JSON.stringify(pi.getAllTools()).length +
						task.length) /
						limits.charsPerToken,
				);
				const promptTokens = Math.max(
					usage?.tokens ?? 0,
					estimatedPromptTokens,
					settings.estimate.initialPromptTokens ?? 0,
				);
				const cachedTokens =
					sameUsageModel && usage?.tokens !== null ? Math.min(promptTokens, measured?.cacheRead ?? 0) : 0;
				const recent = branch
					.slice(-limits.recentResults)
					.filter((entry) => entry.type === "message")
					.map((entry) => {
						if (entry.type !== "message") return null;
						const message = entry.message;
						return {
							role: message.role,
							...(message.role === "toolResult"
								? {
										tool: message.toolName,
										error: message.isError,
										text: contentText(message.content, "\n").slice(0, limits.resultChars),
									}
								: {}),
						};
					});
				const request: DecisionRequest = {
					definition: "generation.route/v1",
					boundaryId: `${context.sessionManager.getSessionId()}:${phaseKey}`,
					stateRevision: before,
					currentCandidateId: "keep_current",
					features: {
						...options.features?.(context),
						task: task.slice(0, limits.taskChars),
						phase,
						current: { ...effective(), tools: event.systemPromptOptions.selectedTools },
						pendingInput: context.hasPendingMessages(),
						contextTokens: promptTokens,
						...(requirements ? { contextRequirements: requirements } : {}),
						cacheRead: cachedTokens,
						cacheWrite: measured?.cacheWrite ?? null,
						recent,
						history: records
							.slice(-limits.historyRecords)
							.map((entry) => (entry.type === "custom" ? { id: entry.id, data: entry.data as Json } : null)),
					},
					candidates: [
						{ id: "keep_current", description: "Keep the current model, effort and tools", attributes: {} },
						...routes.map((route) => ({
							id: route.id,
							description: route.description,
							attributes: {
								provider: route.provider,
								model: route.model,
								effort: route.effort,
								tools: route.tools,
								...route.metrics,
							},
						})),
					],
				};
				const invocation = await options.registry.invoke(
					settings.binding.implementation,
					request,
					settings.binding.policy,
					{ signal, timeoutMs: settings.timeoutMs, budget },
				);
				if (signal?.aborted || revision() !== before) {
					options.registry.trace({
						event: "outcome",
						traceId: invocation.traceId,
						effectiveAction: "unchanged",
						fallback: "cancelled_or_stale",
						effective: effective(),
					});
					return;
				}
				const result = invocation.result;
				const selected =
					result.status === "proposed" && result.answer.kind === "select" ? result.answer.candidateId : undefined;
				const route = routes.find(({ id }) => id === selected);
				let fallback = result.status !== "proposed" ? result.reason : undefined;
				let admission: RouteTrace["admission"] = selected === "keep_current" ? "unchanged" : undefined;
				let costs: { stay: number; switch: number } | undefined;
				if (route) {
					const target = context.modelRegistry.find(route.provider, route.model)!;
					const same =
						target.provider === currentModel.provider &&
						target.id === currentModel.id &&
						route.effort === pi.getThinkingLevel() &&
						digestJson(route.tools) === digestJson(pi.getActiveTools());
					if (!same)
						costs = estimateRoutingCosts({
							promptTokens,
							cachedTokens,
							requests: settings.estimate.requests,
							outputTokens: settings.estimate.outputTokens,
							current: currentModel.cost,
							target: target.cost,
							decisionCostUsd: Math.max(settings.estimate.decisionCostUsd, invocation.costUsd ?? 0),
						});
					const admitted =
						same ||
						(costs !== undefined &&
							(costs.stay - costs.switch > settings.estimate.marginUsd ||
								(settings.escalationMaxUsd !== undefined && costs.switch <= settings.escalationMaxUsd)));
					if (!admitted) fallback = costs ? "switch-cost" : "unknown-cost";
					else {
						admission = same
							? "unchanged"
							: costs && costs.stay - costs.switch > settings.estimate.marginUsd
								? "economy"
								: "capability";
						pi.appendEntry("decision-route-pending", {
							phase: phaseKey,
							boundaryId: request.boundaryId,
							policyDigest: invocation.policyDigest,
							proposal: route.id,
							effective: effective(),
						});
						const applyRevision = revision();
						try {
							const applied = await pi.setModel(target, {
								signal,
								beforeApply: () => revision() === applyRevision,
								configuration: { effort: route.effort, tools: route.tools },
							});
							if (!applied) fallback = "model-auth-or-stale";
							else {
								// Notifications run after the joint commit and may contain a newer user choice.
								// Preserve that choice rather than applying another piece of the old preset.
								event.systemPromptOptions.selectedTools = pi.getActiveTools();
								if (
									signal?.aborted ||
									context.model?.provider !== route.provider ||
									context.model?.id !== route.model ||
									pi.getThinkingLevel() !== route.effort ||
									digestJson(pi.getActiveTools()) !== digestJson(route.tools)
								)
									fallback = "superseded";
							}
						} catch {
							fallback = "apply-failed";
						}
					}
				}
				const { result: _result, ...metadata } = invocation;
				const trace: RouteTrace = {
					phase: phaseKey,
					boundaryId: request.boundaryId,
					policyDigest: invocation.policyDigest,
					effective: effective(),
					invocation: metadata,
					...(selected ? { proposal: selected } : {}),
					...(fallback ? { fallback } : {}),
					...(admission ? { admission } : {}),
					...(costs ? { costs } : {}),
				};
				// Persistence is required for phase pinning; callback telemetry is best effort.
				pi.appendEntry("decision-route", trace);
				options.registry.trace({
					event: "outcome",
					traceId: invocation.traceId,
					...trace,
					admissionInputs: {
						promptTokens,
						cachedTokens,
						estimate: settings.estimate,
						escalationMaxUsd: settings.escalationMaxUsd ?? null,
						currentRates: currentModel.cost,
						targetRates: route ? context.modelRegistry.find(route.provider, route.model)?.cost : null,
					},
				});
				try {
					options.onRecord?.(trace);
				} catch {
					/* Telemetry cannot control execution. */
				}
			});
		},
	};
}
