import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type DecisionInvocation, type DecisionRegistry, digestJson, type Json } from "@earendil-works/pi-decisions";
import { createContextExcerpt, estimateRequestTokens } from "../core/context-budget.ts";
import type { ExtensionContext, InlineExtension } from "../core/extensions/types.ts";
import { buildSessionContext } from "../core/session-manager.ts";
import type { DecisionBinding } from "./decision-routing.ts";

export interface ContextManagementSettings {
	/** Reuse stable plans and prefer a fitting cached prefix when a rewrite would cost more. */
	cacheAware?: boolean;
	cacheExpectedRequests?: number;
	cacheMinSavingsUsd?: number;
	/** Additional input margin beyond the host's output reservation. */
	safetyMarginTokens?: number;
	reserveOutputTokens?: number;
	triggerRatio?: number;
	targetRatio?: number;
	/** A result/call below this probability may be shortened/omitted. Uncertainty defaults to retention. */
	keepThreshold?: number;
	preserveRecentMessages?: number;
	excerptChars?: number;
	stateChars?: number;
	requestChars?: number;
	maxRequests?: number;
	concurrency?: number;
	minReduction?: number;
	recallMaxChars?: number;
}

const defaults = {
	cacheAware: true,
	cacheExpectedRequests: 3,
	cacheMinSavingsUsd: 0,
	safetyMarginTokens: 2048,
	reserveOutputTokens: 0,
	triggerRatio: 0.9,
	targetRatio: 0.75,
	keepThreshold: 0.3,
	preserveRecentMessages: 6,
	excerptChars: 1200,
	stateChars: 48000,
	requestChars: 80000,
	maxRequests: 8,
	concurrency: 2,
	minReduction: 0.1,
	recallMaxChars: 4000,
};

type Settings = typeof defaults;
type Retention = "keep" | "excerpt" | "omit";
interface Unit {
	id: string;
	callIndex: number;
	resultIndex: number;
	tool: string;
	input: string;
	text: string;
	digest: string;
	pinned: boolean;
}
interface Selection {
	id: string;
	digest: string;
	action: Retention;
}
interface ContextPlan {
	version: 1;
	key: string;
	selections: Selection[];
	tokensBefore: number;
	tokensAfter: number;
	maxInputTokens: number;
	invocations: Omit<DecisionInvocation, "result">[];
	scores: Record<string, number>;
}
const PLAN = "decision-context-plan/v1";

export function validateContextManagementSettings(input: ContextManagementSettings): Settings {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).some((key) => !Object.hasOwn(defaults, key))
	)
		throw new Error("Invalid context management settings");
	const settings = { ...defaults, ...input };
	if (typeof settings.cacheAware !== "boolean") throw new Error("Invalid context cacheAware setting");
	for (const [key, value] of Object.entries(settings))
		if (key !== "cacheAware" && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
			throw new Error(`Invalid context setting: ${key}`);
	if (
		!(settings.targetRatio > 0 && settings.targetRatio < settings.triggerRatio && settings.triggerRatio <= 1) ||
		settings.keepThreshold > 1 ||
		settings.minReduction >= 1
	)
		throw new Error("Invalid context thresholds");
	for (const key of [
		"safetyMarginTokens",
		"reserveOutputTokens",
		"preserveRecentMessages",
		"excerptChars",
		"stateChars",
		"requestChars",
		"maxRequests",
		"concurrency",
		"recallMaxChars",
		"cacheExpectedRequests",
	] as const)
		if (!Number.isSafeInteger(settings[key])) throw new Error(`Context setting must be an integer: ${key}`);
	if (
		settings.cacheExpectedRequests < 1 ||
		settings.excerptChars < 64 ||
		settings.stateChars < 1024 ||
		settings.requestChars < settings.stateChars + 1024 ||
		settings.maxRequests < 1 ||
		settings.concurrency < 1 ||
		settings.concurrency > settings.maxRequests ||
		settings.recallMaxChars < 1 ||
		settings.recallMaxChars > 64000
	)
		throw new Error("Invalid context input limits");
	return settings;
}

function textOf(message: AgentMessage): string {
	if ("content" in message) {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "summary" in message ? message.summary : "";
}

function excerpt(text: string, chars: number): string {
	if (text.length <= chars) return text;
	const half = Math.floor(chars / 2);
	return `${text.slice(0, half)}\n[… ${text.length - half * 2} characters omitted …]\n${text.slice(-half)}`;
}

/** Only complete unambiguous text tool pairs are eligible. All conversation text remains intact. */
function collectUnits(messages: AgentMessage[], settings: Settings): Unit[] {
	const calls = new Map<string, { index: number; tool: string; input: string }>();
	const duplicates = new Set<string>();
	const results = new Map<string, number[]>();
	for (const [index, message] of messages.entries()) {
		if (message.role === "assistant")
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (calls.has(part.id)) duplicates.add(part.id);
				calls.set(part.id, { index, tool: part.name, input: JSON.stringify(part.arguments) });
			}
		if (message.role === "toolResult")
			results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), index]);
	}
	const units: Unit[] = [];
	for (const [id, call] of calls) {
		const indices = results.get(id);
		if (duplicates.has(id) || indices?.length !== 1 || indices[0] <= call.index) continue;
		const result = messages[indices[0]];
		if (result.role !== "toolResult") continue;
		const text = textOf(result);
		units.push({
			id,
			callIndex: call.index,
			resultIndex: indices[0],
			tool: call.tool,
			input: call.input,
			text,
			digest: digestJson({ input: call.input, text, error: result.isError, tool: call.tool }),
			pinned:
				call.index === 0 ||
				indices[0] >= messages.length - settings.preserveRecentMessages ||
				result.isError ||
				result.content.some((part) => part.type !== "text") ||
				call.tool === "recall_context",
		});
	}
	return units;
}

/** Reconstruct a provider view; never modify the original transcript or leave orphan results. */
function project(messages: AgentMessage[], units: Unit[], selections: Selection[], settings: Settings): AgentMessage[] {
	const actions = new Map(selections.map((selection) => [selection.id, selection]));
	const omissions = new Set<string>();
	const excerpts = new Map<string, Unit>();
	for (const unit of units) {
		const selected = actions.get(unit.id);
		if (unit.pinned || !selected || selected.digest !== unit.digest) continue;
		if (selected.action === "omit") omissions.add(unit.id);
		if (selected.action === "excerpt") excerpts.set(unit.id, unit);
	}
	return messages.flatMap((message): AgentMessage[] => {
		if (message.role === "toolResult") {
			if (omissions.has(message.toolCallId)) return [];
			const unit = excerpts.get(message.toolCallId);
			if (unit) {
				const text = createContextExcerpt(unit.text, settings.excerptChars, unit.id);
				if (text.length < unit.text.length) return [{ ...message, content: [{ type: "text", text }] }];
			}
		}
		if (message.role === "assistant") {
			const content = message.content.filter((part) => part.type !== "toolCall" || !omissions.has(part.id));
			if (!content.length) return [];
			if (content.length !== message.content.length) return [{ ...message, content }];
		}
		return [message];
	});
}

/** A pre-render lower bound for routing, not a promise that semantic selection will attain it. */
export function contextRequirements(context: ExtensionContext, input: ContextManagementSettings) {
	const settings = validateContextManagementSettings(input);
	const messages = buildSessionContext(context.sessionManager.getBranch()).messages;
	const units = collectUnits(messages, settings);
	const minimum = project(
		messages,
		units,
		units.map((unit) => ({ id: unit.id, digest: unit.digest, action: "omit" })),
		settings,
	);
	return {
		minimumTokens: estimateRequestTokens(minimum),
		fullTokens: estimateRequestTokens(messages),
		reserveTokens: settings.reserveOutputTokens,
		safetyMarginTokens: settings.safetyMarginTokens,
	};
}

function readPlan(context: ExtensionContext): ContextPlan | undefined {
	const entry = [...context.sessionManager.getBranch()]
		.reverse()
		.find((value) => value.type === "custom" && value.customType === PLAN);
	if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object") return undefined;
	const plan = entry.data as ContextPlan;
	return plan.version === 1 &&
		typeof plan.key === "string" &&
		Array.isArray(plan.selections) &&
		plan.selections.every(
			(item) =>
				item &&
				typeof item.id === "string" &&
				typeof item.digest === "string" &&
				["keep", "excerpt", "omit"].includes(item.action),
		)
		? plan
		: undefined;
}

/** Shared pre-construction selection and projection for generation and compaction. */
export function createDecisionContextExtension(options: {
	settings: ContextManagementSettings;
	registry: DecisionRegistry;
	binding: DecisionBinding;
	timeoutMs?: number;
	maxDecisions?: number;
	budget?: { remaining: number };
	/** Host-approved additional private state; callers own redaction. */
	features?(context: ExtensionContext): Record<string, Json>;
}): InlineExtension {
	const settings = validateContextManagementSettings(options.settings);
	const binding = structuredClone(options.binding);
	const identity = digestJson({ settings, binding });
	return {
		name: "decision-context",
		hidden: true,
		factory(pi) {
			const budget = options.budget ?? { remaining: options.maxDecisions ?? 100 };
			pi.on("context_management", async (event, context) => {
				const maxInputTokens = Math.max(
					0,
					event.model.contextWindow -
						Math.max(event.reserveTokens, settings.reserveOutputTokens) -
						settings.safetyMarginTokens,
				);
				const before = estimateRequestTokens(event.messages, event.tools) + event.promptOverheadTokens;
				const task = [...event.messages].reverse().find((message) => message.role === "user");
				const phase = [...context.sessionManager.getBranch()]
					.reverse()
					.find((entry) => entry.type === "custom" && entry.customType === "decision-phase");
				const key = digestJson({
					identity,
					prompt: event.promptIdentity,
					task: task ? textOf(task) : "",
					phase: phase?.id ?? "initial",
					model: `${event.model.provider}/${event.model.id}`,
					effort: pi.getThinkingLevel(),
					tools: pi.getActiveTools(),
					failures: event.messages
						.filter((message) => message.role === "toolResult" && message.isError)
						.map((message) => (message.role === "toolResult" ? message.toolCallId : "")),
				});
				const units = collectUnits(event.messages, settings);
				const previous = readPlan(context);
				const cached =
					previous?.key === key ? project(event.messages, units, previous.selections, settings) : event.messages;
				const cachedTokens = estimateRequestTokens(cached, event.tools) + event.promptOverheadTokens;
				const explicit = event.reason === "manual" || event.reason === "overflow";
				const changedTask = previous !== undefined && previous.key !== key;
				if (
					settings.cacheAware &&
					!explicit &&
					!changedTask &&
					cachedTokens <= maxInputTokens * settings.triggerRatio
				)
					return { action: "selected", messages: cached, maxInputTokens };
				const revision = context.sessionManager.getLeafId();
				const pendingBefore = context.hasPendingMessages();
				const features: Record<string, Json> = {
					...options.features?.(context),
					task: excerpt(task ? textOf(task) : "", settings.excerptChars * 2),
					phase: phase?.type === "custom" ? (JSON.parse(JSON.stringify(phase.data)) as Json) : null,
					pendingInput: pendingBefore,
					compactionInstructions: event.customInstructions
						? excerpt(event.customInstructions, settings.excerptChars)
						: null,
					model: `${event.model.provider}/${event.model.id}`,
					effort: pi.getThinkingLevel(),
					activeTools: pi.getActiveTools(),
					maxInputTokens,
					targetTokens: Math.floor(maxInputTokens * settings.targetRatio),
				};
				// Keep an ordered overview of every message; reduce excerpts, never silently omit an unjudged unit.
				let state: Record<string, Json> | undefined;
				for (const size of [settings.excerptChars, Math.min(settings.excerptChars, 200), 0]) {
					const overview = event.messages.map((message, index) => ({
						index,
						role: message.role,
						text: size ? excerpt(textOf(message), size) : `[${textOf(message).length} characters; not inspected]`,
						...(message.role === "assistant"
							? {
									calls: message.content
										.filter((part) => part.type === "toolCall")
										.map((part) => ({
											id: part.id,
											tool: part.name,
											input: size ? excerpt(JSON.stringify(part.arguments), size) : "[not inspected]",
										})),
								}
							: {}),
						...(message.role === "toolResult"
							? { tool: message.toolName, callId: message.toolCallId, error: message.isError }
							: {}),
					}));
					const candidateState = { ...features, overview };
					if (JSON.stringify(candidateState).length <= settings.stateChars) {
						state = candidateState;
						break;
					}
				}
				if (!state || maxInputTokens === 0) return { action: "compact", maxInputTokens };
				const projectedState = state;
				const candidates = units
					.filter((unit) => !unit.pinned)
					.flatMap((unit) =>
						["call", "result"].map((kind) => ({
							id: `${unit.id}:${kind}`,
							description:
								kind === "call"
									? `${unit.tool}: ${excerpt(unit.input, settings.excerptChars)}`
									: excerpt(unit.text, settings.excerptChars),
							attributes: {
								kind,
								toolCallId: unit.id,
								tool: unit.tool,
								originalChars: kind === "call" ? unit.input.length : unit.text.length,
							},
						})),
					);
				const batches: (typeof candidates)[] = [];
				let batch: typeof candidates = [];
				let chars = JSON.stringify(state).length + JSON.stringify(binding.policy).length + 1024;
				const baseChars = chars;
				for (const candidate of candidates) {
					const cost = JSON.stringify(candidate).length;
					if (cost + baseChars > settings.requestChars) continue;
					if (batch.length >= 120 || chars + cost > settings.requestChars) {
						batches.push(batch);
						batch = [];
						chars = baseChars;
					}
					batch.push(candidate);
					chars += cost;
				}
				if (batch.length) batches.push(batch);
				const scores: Record<string, number> = {};
				const invocations: ContextPlan["invocations"] = [];
				const pending = batches.slice(0, settings.maxRequests);
				for (let i = 0; i < pending.length; i += settings.concurrency) {
					const results = await Promise.all(
						pending.slice(i, i + settings.concurrency).map((items, offset) =>
							options.registry.invoke(
								binding.implementation,
								{
									definition: "context.retention/v1",
									boundaryId: `${context.sessionManager.getSessionId()}:${revision ?? "initial"}:${i + offset}`,
									stateRevision: revision ?? "initial",
									features: projectedState,
									candidates: items,
								},
								binding.policy,
								{ signal: event.signal, timeoutMs: options.timeoutMs ?? 5000, budget },
							),
						),
					);
					for (const invocation of results) {
						const { result, ...metadata } = invocation;
						invocations.push(metadata);
						if (result.status === "proposed" && result.answer.kind === "score")
							Object.assign(scores, result.answer.values);
					}
					if (event.signal?.aborted) break;
				}
				if (
					event.signal?.aborted ||
					context.sessionManager.getLeafId() !== revision ||
					context.hasPendingMessages() !== pendingBefore
				)
					return { action: "compact", maxInputTokens };
				const selections: Selection[] = units.map((unit) => {
					const call = scores[`${unit.id}:call`];
					const result = scores[`${unit.id}:result`];
					return {
						id: unit.id,
						digest: unit.digest,
						action:
							unit.pinned || call === undefined || result === undefined || result >= settings.keepThreshold
								? "keep"
								: call >= settings.keepThreshold
									? "excerpt"
									: "omit",
					};
				});
				const messages = project(event.messages, units, selections, settings);
				const after = estimateRequestTokens(messages, event.tools) + event.promptOverheadTokens;
				// Cache retention is a cost preference, never authority to exceed capacity or ignore a changed task.
				if (
					settings.cacheAware &&
					previous?.key === key &&
					!explicit &&
					cachedTokens <= maxInputTokens &&
					after < cachedTokens
				) {
					const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
					const rates = event.model.cost;
					const observedCache =
						lastAssistant?.role === "assistant" &&
						lastAssistant.model === event.model.id &&
						lastAssistant.provider === event.model.provider
							? Math.min(cachedTokens, lastAssistant.usage.cacheRead)
							: 0;
					if (
						observedCache > 0 &&
						Number.isFinite(observedCache) &&
						[rates.input, rates.cacheRead, rates.cacheWrite].every((rate) => Number.isFinite(rate) && rate >= 0)
					) {
						let common = 0;
						while (
							common < Math.min(cached.length, messages.length) &&
							JSON.stringify(cached[common]) === JSON.stringify(messages[common])
						)
							common++;
						// ponytail: serialized prefix size estimates cache survival; provider-specific counters can refine it.
						const prefixTokens = Math.min(
							observedCache,
							event.promptOverheadTokens + estimateRequestTokens(cached.slice(0, common), event.tools),
						);
						const cold = Math.max(rates.input, rates.cacheWrite);
						const warm = rates.cacheRead || rates.input;
						const future = settings.cacheExpectedRequests - 1;
						const stay =
							(cachedTokens - observedCache) * cold +
							observedCache * rates.cacheRead +
							future * cachedTokens * warm;
						const change = (after - prefixTokens) * cold + prefixTokens * rates.cacheRead + future * after * warm;
						if ((stay - change) / 1e6 <= settings.cacheMinSavingsUsd) {
							return { action: "selected", messages: cached, maxInputTokens };
						}
					}
				}
				const worthwhile = before === 0 || after <= before * (1 - settings.minReduction);
				if (after > maxInputTokens || ((explicit || after > maxInputTokens * settings.targetRatio) && !worthwhile))
					return { action: "compact", maxInputTokens };
				const plan: ContextPlan = {
					version: 1,
					key,
					selections,
					tokensBefore: before,
					tokensAfter: after,
					maxInputTokens,
					invocations,
					scores,
				};
				pi.appendEntry(PLAN, plan);
				return { action: "selected", messages, maxInputTokens };
			});
		},
	};
}
