import type {
	Candidate,
	DecisionInvocation,
	DecisionRequest,
	DecisionResult,
	Json,
} from "@earendil-works/pi-decisions";
import { digestJson } from "@earendil-works/pi-decisions";
import { Type } from "typebox";
import type { ExtensionContext, InlineExtension, ToolDefinition } from "../core/extensions/types.ts";

export type ComponentDecision = DecisionResult & { invocation?: Omit<DecisionInvocation, "result"> };

export interface DecisionComponentsOptions {
	/** The trusted host owns approved feature projection and any redaction before remote evaluation. */
	evaluate(request: DecisionRequest, signal?: AbortSignal): Promise<ComponentDecision>;
	output?: { tools: string[]; minChars: number; maxChars: number; blockLines: number; minReduction: number };
	retrieval?: { minChars: number; maxChars: number; minReduction: number };
	review?: { tools: string[]; onFailure: "block" | "proceed" };
	completion?: { maxPasses: number; followUps?: { verify: string; clarify: string } };
	state?(context: ExtensionContext): Record<string, Json>;
	onRecord?(record: DecisionComponentRecord): void;
}

/** Metadata only: no input, output text, provider evidence, or arbitrary provider error strings. */
export interface DecisionComponentRecord {
	definition: string;
	boundaryId: string;
	stateRevision: string;
	candidateIds: string[];
	selectedIds: string[];
	outcome: DecisionResult["status"];
	/** Adapter effect handed to Pi. Later extension decisions and tool outcomes are separate observations. */
	effectiveAction: "unchanged" | "trim" | "proceed" | "block" | "accept" | "verify" | "clarify";
	fallback?: string;
	durationMs: number;
	invocation?: Omit<DecisionInvocation, "result">;
}

const ORIGINAL_OUTPUT = "decision-original-output/v1";
const COMPLETION_PASS = "decision-completion-pass/v1";

const recallSchema = Type.Object({
	id: Type.String(),
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	endLine: Type.Optional(Type.Integer({ minimum: 1 })),
});
const recallTool: ToolDefinition<typeof recallSchema> = {
	name: "recall_output",
	label: "Recall output",
	description:
		"Recall exact original tool output stored on the current session branch. Line numbers are one-based and inclusive.",
	parameters: recallSchema,
	async execute(_id, params, _signal, _update, context) {
		for (const entry of context.sessionManager.getBranch().slice().reverse()) {
			if (
				entry.type !== "custom" ||
				entry.customType !== ORIGINAL_OUTPUT ||
				!entry.data ||
				typeof entry.data !== "object"
			)
				continue;
			const data = entry.data as { id?: unknown; text?: unknown };
			if (data.id !== params.id || typeof data.text !== "string") continue;
			const lines = data.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
			const start = params.startLine ?? 1;
			const end = params.endLine ?? lines.length;
			if (start > end || start > lines.length) throw new Error("Invalid recall line range");
			return {
				content: [{ type: "text", text: lines.slice(start - 1, end).join("") }],
				details: { id: params.id, startLine: start, endLine: Math.min(end, lines.length) },
			};
		}
		throw new Error("No original output with this ID on the current branch");
	},
};

/** Recall remains available when decisions are disabled, without adding a tool to fresh sessions. */
export function createDecisionRecallExtension(): InlineExtension {
	return {
		name: "decision-recall",
		hidden: true,
		factory(pi) {
			pi.on("session_start", (_event, context) => {
				if (
					context.sessionManager
						.getBranch()
						.some((entry) => entry.type === "custom" && entry.customType === ORIGINAL_OUTPUT) &&
					!pi.getAllTools().some((tool) => tool.name === "recall_output")
				)
					pi.registerTool(recallTool);
			});
		},
	};
}

/** Select only an existing bounded roster; required/dependent groups survive every implementation. */
export async function selectDecisionContext(
	request: DecisionRequest,
	evaluate: DecisionComponentsOptions["evaluate"],
	signal?: AbortSignal,
): Promise<readonly string[]> {
	const all = request.candidates.map((candidate) => candidate.id);
	try {
		const result = await evaluate(request, signal);
		if (signal?.aborted || result.status !== "proposed" || result.answer.kind !== "subset") return all;
		const selected = new Set(result.answer.candidateIds);
		if (selected.size !== result.answer.candidateIds.length || [...selected].some((id) => !all.includes(id)))
			return all;
		for (const candidate of request.candidates)
			if (candidate.attributes.required === true) selected.add(candidate.id);
		const groups = new Set(
			request.candidates
				.filter((candidate) => selected.has(candidate.id))
				.map((candidate) => candidate.attributes.group)
				.filter((group) => typeof group === "string"),
		);
		return request.candidates
			.filter(
				(candidate) =>
					selected.has(candidate.id) ||
					(typeof candidate.attributes.group === "string" && groups.has(candidate.attributes.group)),
			)
			.map((candidate) => candidate.id);
	} catch {
		return all;
	}
}

/** Optional adapters use the host's configured registry. No component constructs its own transport. */
export function createDecisionComponentsExtension(options: DecisionComponentsOptions): InlineExtension {
	for (const config of [options.output, options.review]) {
		if (
			config &&
			(!Array.isArray(config.tools) ||
				config.tools.some((name) => typeof name !== "string" || !name.trim()) ||
				new Set(config.tools).size !== config.tools.length)
		)
			throw new Error("Component tools must be unique nonempty names");
	}
	if (options.review && !["block", "proceed"].includes(options.review.onFailure))
		throw new Error("Invalid review failure policy");
	if (
		options.completion?.followUps &&
		Object.entries(options.completion.followUps).some(
			([key, value]) =>
				!["verify", "clarify"].includes(key) || typeof value !== "string" || !value.trim() || value.length > 8000,
		)
	)
		throw new Error("Invalid completion follow-ups");
	for (const config of [options.output, options.retrieval]) {
		if (
			config &&
			(!Number.isFinite(config.minChars) ||
				config.minChars < 1 ||
				!Number.isFinite(config.maxChars) ||
				config.maxChars < config.minChars ||
				!Number.isFinite(config.minReduction) ||
				config.minReduction <= 0 ||
				config.minReduction >= 1)
		)
			throw new Error("Invalid output selection limits");
	}
	if (options.output && (!Number.isSafeInteger(options.output.blockLines) || options.output.blockLines < 1))
		throw new Error("Invalid block line count");
	if (
		options.completion &&
		(!Number.isSafeInteger(options.completion.maxPasses) ||
			options.completion.maxPasses < 1 ||
			options.completion.maxPasses > 3)
	)
		throw new Error("Completion maxPasses must be 1..3");
	return {
		name: "decision-components",
		hidden: true,
		factory(pi) {
			const record = (value: DecisionComponentRecord, persist = true) => {
				try {
					if (persist) pi.appendEntry("decision-component/v1", value);
				} catch {
					/* Diagnostics never change execution. */
				}
				try {
					options.onRecord?.(structuredClone(value));
				} catch {
					/* External diagnostics are isolated too. */
				}
			};
			pi.on("session_start", (_event, context) => {
				const available = new Set(pi.getAllTools().map((tool) => tool.name));
				const unknown = [...new Set([...(options.output?.tools ?? []), ...(options.review?.tools ?? [])])].filter(
					(name) => !available.has(name),
				);
				if (unknown.length)
					context.ui.notify(`Decision component tools unavailable: ${unknown.join(", ")}`, "warning");
			});
			if (options.output || options.retrieval) pi.registerTool(recallTool);
			if (options.output || options.retrieval) {
				pi.on("tool_result", async (event, context) => {
					const retrieval = Boolean(options.retrieval && ["grep", "find"].includes(event.toolName));
					const config =
						retrieval && options.retrieval
							? { ...options.retrieval, tools: ["grep", "find"], blockLines: 1 }
							: options.output;
					if (
						!config ||
						!config.tools.includes(event.toolName) ||
						["read", "edit", "write", "recall_output"].includes(event.toolName) ||
						event.isError ||
						event.content.length !== 1 ||
						event.content[0].type !== "text"
					)
						return;
					if (
						retrieval &&
						event.details &&
						typeof event.details === "object" &&
						Object.entries(event.details).some(
							([key, value]) =>
								["truncation", "linesTruncated", "matchLimitReached", "resultLimitReached"].includes(key) &&
								Boolean(value),
						)
					)
						return;
					const snapshot = componentSnapshot(context, options);
					const text = event.content[0].text;
					if (
						text.length < config.minChars ||
						text.length > config.maxChars ||
						/\b(full|complete|untruncated|verbatim|entire|all)\b.{0,32}\b(output|results?|logs?|diff)\b|\b(do not|don't|never)\s+(trim|truncate|summarize)\b/i.test(
							String(snapshot.features.task),
						) ||
						/\b(git\s+diff|diff\s|cat\s|sed\s|head\s|tail\s)/.test(JSON.stringify(event.input)) ||
						/^diff --git|^@@ /m.test(text)
					)
						return;
					const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
					const terms =
						String(snapshot.features.task)
							.toLowerCase()
							.match(/[\w./-]{4,}/g) ?? [];
					const candidates: Candidate[] = [];
					for (let i = 0; i < lines.length; i += config.blockLines) {
						const block = lines.slice(i, i + config.blockLines).join("");
						const group = retrieval
							? event.toolName === "grep"
								? block.match(/^(.+?)(?::\d+:|-\d+-) /)?.[1]
								: block.trimEnd()
							: undefined;
						const required =
							i === 0 ||
							i + config.blockLines >= lines.length ||
							(retrieval
								? !group || /^\s*\[/.test(block) || String(snapshot.features.task).includes(group)
								: /\b(error|fail(?:ed|ure)?|exception|warning)\b|\S+[/\\]\S+|\.[a-z]+:\d+/i.test(block) ||
									terms.some((term) => block.toLowerCase().includes(term)));
						candidates.push({
							id: String(i + 1),
							description: block,
							attributes: { required, startLine: i + 1, ...(group ? { group } : {}) },
						});
					}
					if (candidates.length > 255 || candidates.every((candidate) => candidate.attributes.required)) return;
					const started = performance.now();
					let result: ComponentDecision = { status: "failed", reason: "evaluation_failed" };
					const definition = retrieval ? "retrieval.rank/v1" : "output.select/v1";
					const selected = new Set(
						await selectDecisionContext(
							{ ...snapshot, definition, boundaryId: event.toolCallId, candidates },
							async (request, signal) => {
								result = await options.evaluate(request, signal);
								return result;
							},
							context.signal,
						),
					);
					const trace: DecisionComponentRecord = {
						definition,
						boundaryId: event.toolCallId,
						stateRevision: snapshot.stateRevision,
						candidateIds: candidates.map((candidate) => candidate.id),
						selectedIds: [...selected],
						outcome: result.status,
						effectiveAction: "unchanged",
						durationMs: performance.now() - started,
						...(result.invocation ? { invocation: result.invocation } : {}),
					};
					if (context.signal?.aborted || componentRevision(context) !== snapshot.stateRevision) {
						record({ ...trace, fallback: "cancelled_or_stale" }, false);
						return;
					}
					const retained = candidates
						.map((candidate, index) =>
							selected.has(candidate.id)
								? candidate.description
								: `[Lines ${candidate.id}-${Math.min((index + 1) * config.blockLines, lines.length)} omitted; use recall_output.]\n`,
						)
						.join("");
					const replacement = `${retained}\n[Output reduced; recall_output id=${event.toolCallId} retrieves the exact original (${lines.length} lines).]\n`;
					if (replacement.length > text.length * (1 - config.minReduction)) {
						record({ ...trace, fallback: "insufficient_reduction" });
						return;
					}
					try {
						pi.appendEntry(ORIGINAL_OUTPUT, { id: event.toolCallId, text });
						if (
							!context.sessionManager
								.getBranch()
								.some(
									(entry) =>
										entry.type === "custom" &&
										entry.customType === ORIGINAL_OUTPUT &&
										typeof entry.data === "object" &&
										entry.data !== null &&
										"id" in entry.data &&
										entry.data.id === event.toolCallId,
								)
						) {
							record({ ...trace, fallback: "original_not_persisted" });
							return;
						}
					} catch {
						record({ ...trace, fallback: "original_not_persisted" });
						return;
					}
					record({ ...trace, effectiveAction: "trim" });
					return { content: [{ type: "text", text: replacement }] };
				});
			}
			if (options.review)
				pi.on("tool_call", async (event, context) => {
					if (!options.review?.tools.includes(event.toolName)) return;
					const snapshot = componentSnapshot(context, options);
					const started = performance.now();
					let outcome: DecisionResult["status"] = "failed";
					let fallback: string | undefined = "evaluation_failed";
					let selected = options.review.onFailure === "block" ? "block" : "proceed";
					let invocation: ComponentDecision["invocation"];
					try {
						const result = await options.evaluate(
							{
								...snapshot,
								definition: "tools.review/v1",
								boundaryId: event.toolCallId,
								features: {
									...snapshot.features,
									toolName: event.toolName,
									input: JSON.parse(JSON.stringify(event.input)) as Json,
								},
								candidates: ["proceed", "request_review", "block"].map((id) => ({
									id,
									description: id,
									attributes: {},
								})),
							},
							context.signal,
						);
						outcome = result.status;
						invocation = result.invocation;
						fallback = result.status === "proposed" ? "invalid_answer" : result.status;
						if (
							result.status === "proposed" &&
							result.answer.kind === "select" &&
							["proceed", "request_review", "block"].includes(result.answer.candidateId)
						) {
							selected = result.answer.candidateId;
							fallback = undefined;
						}
					} catch {
						/* The configured fallback owns transport failures. */
					}
					const trace: DecisionComponentRecord = {
						definition: "tools.review/v1",
						boundaryId: event.toolCallId,
						stateRevision: snapshot.stateRevision,
						candidateIds: ["proceed", "request_review", "block"],
						selectedIds: [selected],
						outcome,
						effectiveAction: selected === "proceed" ? "proceed" : "block",
						...(fallback ? { fallback } : {}),
						durationMs: performance.now() - started,
						...(invocation ? { invocation } : {}),
					};
					if (context.signal?.aborted || componentRevision(context) !== snapshot.stateRevision) {
						record({ ...trace, effectiveAction: "block", fallback: "cancelled_or_stale" }, false);
						return { block: true, reason: "Tool review cancelled or stale" };
					}
					record(trace);
					if (selected !== "proceed")
						return {
							block: true,
							reason:
								selected === "request_review"
									? "Semantic review requires user review; no permission was granted"
									: "Blocked by semantic tool review",
						};
					return;
				});
			if (options.completion)
				pi.on("agent_end", async (_event, context) => {
					if (context.hasPendingMessages() || context.signal?.aborted) return;
					const snapshot = componentSnapshot(context, options);
					const branch = context.sessionManager.getBranch();
					const taskId = [...branch]
						.reverse()
						.find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
					const passes = branch.filter(
						(entry) => entry.type === "custom" && entry.customType === COMPLETION_PASS && entry.data === taskId,
					).length;
					if (!taskId || passes >= (options.completion?.maxPasses ?? 1)) return;
					const lastTaskIndex = branch.findIndex((entry) => entry.id === taskId);
					const callKeys = new Map<string, string>();
					const failures = new Map<string, boolean>();
					for (const entry of branch.slice(lastTaskIndex)) {
						if (entry.type !== "message") continue;
						if (entry.message.role === "assistant")
							for (const part of entry.message.content) {
								if (part.type === "toolCall")
									callKeys.set(part.id, digestJson({ tool: part.name, arguments: part.arguments }));
							}
						if (entry.message.role === "toolResult")
							failures.set(
								callKeys.get(entry.message.toolCallId) ?? entry.message.toolCallId,
								entry.message.isError,
							);
					}
					// ponytail: identical retries clear failures; richer check identities belong to check-producing tools.
					const failed = [...failures.values()].some(Boolean);
					let selected = failed ? "verify" : "accept";
					const started = performance.now();
					let outcome: DecisionResult["status"] = "failed";
					let fallback: string | undefined = failed ? "failed_checks" : "evaluation_failed";
					let invocation: ComponentDecision["invocation"];
					try {
						const result = await options.evaluate(
							{
								...snapshot,
								definition: "completion.verify/v1",
								boundaryId: `${taskId}:${passes}`,
								features: { ...snapshot.features, failedChecks: failed },
								candidates: ["accept", "verify", "clarify"].map((id) => ({
									id,
									description: id,
									attributes: {},
								})),
							},
							context.signal,
						);
						outcome = result.status;
						invocation = result.invocation;
						if (!failed) fallback = result.status === "proposed" ? "invalid_answer" : result.status;
						if (
							!failed &&
							result.status === "proposed" &&
							result.answer.kind === "select" &&
							["accept", "verify", "clarify"].includes(result.answer.candidateId)
						) {
							selected = result.answer.candidateId;
							fallback = undefined;
						}
					} catch {
						/* Failed checks still require bounded verification. */
					}
					const trace: DecisionComponentRecord = {
						definition: "completion.verify/v1",
						boundaryId: `${taskId}:${passes}`,
						stateRevision: snapshot.stateRevision,
						candidateIds: ["accept", "verify", "clarify"],
						selectedIds: [selected],
						outcome,
						effectiveAction: "accept",
						...(fallback ? { fallback } : {}),
						durationMs: performance.now() - started,
						...(invocation ? { invocation } : {}),
					};
					if (
						context.hasPendingMessages() ||
						context.signal?.aborted ||
						componentRevision(context) !== snapshot.stateRevision
					) {
						record(
							{ ...trace, effectiveAction: "unchanged", fallback: "pending_input_cancelled_or_stale" },
							false,
						);
						return;
					}
					if (!["verify", "clarify"].includes(selected)) {
						record(trace);
						return;
					}
					try {
						pi.appendEntry(COMPLETION_PASS, taskId);
					} catch {
						record({ ...trace, fallback: "pass_not_persisted" });
						return;
					}
					pi.sendMessage(
						{
							customType: "decision-verification",
							content:
								selected === "verify"
									? (options.completion?.followUps?.verify ??
										"Verify the claimed result against actual checks. Resolve or explicitly report failed checks and missing evidence before finishing.")
									: (options.completion?.followUps?.clarify ??
										"Ask the user for the missing information required to finish; do not invent an answer."),
							display: true,
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					record({ ...trace, effectiveAction: selected === "verify" ? "verify" : "clarify" });
				});
		},
	};
}

function componentSnapshot(context: ExtensionContext, options: DecisionComponentsOptions) {
	const messages = context.sessionManager.getBranch().filter((entry) => entry.type === "message");
	const user = [...messages].reverse().find((entry) => entry.message.role === "user");
	const task = user && "content" in user.message ? user.message.content : "";
	return {
		stateRevision: componentRevision(context),
		features: {
			...options.state?.(context),
			task: (typeof task === "string"
				? task
				: (task
						?.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n") ?? "")
			).slice(0, 8_000),
			pendingInput: context.hasPendingMessages(),
			recentOutcomes: messages.slice(-8).map((entry) => {
				const content = "content" in entry.message ? entry.message.content : "";
				return {
					role: entry.message.role,
					text: (typeof content === "string"
						? content
						: content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n")
					).slice(0, 2_000),
				};
			}),
		},
	};
}

export function componentRevision(context: ExtensionContext): string {
	return (
		[...context.sessionManager.getBranch()]
			.reverse()
			.find(
				(entry) =>
					entry.type !== "custom" ||
					![
						ORIGINAL_OUTPUT,
						"decision-component/v1",
						"decision-workflow",
						"decision-workflow-reservation",
						"decision-specialist-usage",
					].includes(entry.customType),
			)?.id ?? "initial"
	);
}
