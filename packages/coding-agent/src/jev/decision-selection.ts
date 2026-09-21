import type { DecisionRequest } from "@earendil-works/pi-decisions";
import type { BeforeGenerationEvent, ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import type { Skill } from "../core/skills.ts";
import type { DecisionComponentsOptions } from "./decision-components.ts";
import { selectDecisionContext } from "./decision-components.ts";
import type { ContextCandidate } from "./types.ts";

/** Phase-owned visibility selection runs before model routing prices the prospective prompt. */
export function createDecisionSkillSelector(options: {
	evaluate: DecisionComponentsOptions["evaluate"];
	onRecord?(record: Record<string, unknown>): void;
}) {
	let roster: Skill[] = [];
	return async (
		event: BeforeGenerationEvent,
		context: ExtensionContext,
		phaseKey: string,
		pi: ExtensionAPI,
		task: string,
	): Promise<boolean> => {
		if (event.initial || roster.length === 0) roster = [...event.systemPromptOptions.skills];
		const explicit = [...task.matchAll(/(?:\/skill:|\$|<skill name=")([^\s"<>]+)/g)].map((match) => match[1]);
		const previous = [...context.sessionManager.getBranch()]
			.reverse()
			.find(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "decision-skills" &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					"phase" in entry.data &&
					entry.data.phase === phaseKey,
			);
		const data = previous?.type === "custom" ? (previous.data as { ids?: unknown }) : undefined;
		const pinned =
			Array.isArray(data?.ids) && data.ids.every((id) => typeof id === "string")
				? (data.ids as string[])
				: undefined;
		if (pinned) {
			event.systemPromptOptions.skills = roster.filter(
				(skill) => pinned.includes(skill.name) || explicit.includes(skill.name),
			);
			return true;
		}
		const revision = context.sessionManager.getLeafId() ?? "initial";
		let invocation: Awaited<ReturnType<DecisionComponentsOptions["evaluate"]>>["invocation"];
		const selected = await selectDecisionSkills(
			roster,
			explicit,
			{
				boundaryId: `${context.sessionManager.getSessionId()}:${phaseKey}`,
				stateRevision: revision,
				features: {
					task: task.slice(0, 8000),
					phase: phaseKey,
					pendingInput: context.hasPendingMessages(),
					contextTokens: context.getContextUsage()?.tokens ?? null,
				},
			},
			async (request, signal) => {
				const result = await options.evaluate(request, signal);
				invocation = result.invocation;
				return result;
			},
			event.signal,
		);
		if (event.signal?.aborted || (context.sessionManager.getLeafId() ?? "initial") !== revision) {
			options.onRecord?.({
				event: "outcome",
				traceId: invocation?.traceId,
				effectiveAction: "unchanged",
				fallback: "cancelled_or_stale",
			});
			return false;
		}
		try {
			pi.appendEntry("decision-skills", {
				phase: phaseKey,
				ids: selected.map((skill) => skill.name),
				...(invocation ? { invocation } : {}),
			});
		} catch {
			options.onRecord?.({
				event: "outcome",
				traceId: invocation?.traceId,
				effectiveAction: "unchanged",
				fallback: "persist_failed",
			});
			return false;
		}
		event.systemPromptOptions.skills = [...selected];
		options.onRecord?.({
			event: "outcome",
			traceId: invocation?.traceId,
			effectiveAction: "selected",
			ids: selected.map((skill) => skill.name),
			explicit,
		});
		return true;
	};
}

/** Returns actual loaded skills; explicit requests survive and disabled automatic skills stay excluded. */
export async function selectDecisionSkills(
	skills: readonly Skill[],
	explicitNames: readonly string[],
	snapshot: Pick<DecisionRequest, "features" | "boundaryId" | "stateRevision">,
	evaluate: DecisionComponentsOptions["evaluate"],
	signal?: AbortSignal,
): Promise<readonly Skill[]> {
	const eligible = skills.filter((skill) => !skill.disableModelInvocation || explicitNames.includes(skill.name));
	if (eligible.length > 255 || new Set(eligible.map((skill) => skill.name)).size !== eligible.length) return eligible;
	const selected = new Set(
		await selectDecisionContext(
			{
				...snapshot,
				definition: "skills.select/v1",
				candidates: eligible.map((skill) => ({
					id: skill.name,
					description: skill.description,
					attributes: { required: explicitNames.includes(skill.name) },
				})),
			},
			evaluate,
			signal,
		),
	);
	return eligible.filter((skill) => selected.has(skill.name));
}

export interface RetrievedDecisionCandidate extends ContextCandidate {
	/** Dependent excerpts are retained together. */
	group?: string;
	tokens: number;
}

/** A retrieval system supplies excerpts; this function neither rewrites history nor invents sources. */
export async function selectRetrievedContext(
	candidates: readonly RetrievedDecisionCandidate[],
	maxTokens: number,
	snapshot: Pick<DecisionRequest, "features" | "boundaryId" | "stateRevision">,
	evaluate: DecisionComponentsOptions["evaluate"],
	signal?: AbortSignal,
): Promise<readonly RetrievedDecisionCandidate[]> {
	if (
		candidates.length > 255 ||
		!Number.isFinite(maxTokens) ||
		maxTokens < 0 ||
		candidates.some((candidate) => !Number.isFinite(candidate.tokens) || candidate.tokens < 0) ||
		new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
	)
		return candidates;
	const selected = new Set(
		await selectDecisionContext(
			{
				...snapshot,
				definition: "retrieval.rank/v1",
				candidates: candidates.map((candidate) => ({
					id: candidate.id,
					description: `${candidate.source}: ${candidate.label}\n${candidate.excerpt}`,
					attributes: {
						required: candidate.required,
						tokens: candidate.tokens,
						...(candidate.group ? { group: candidate.group } : {}),
					},
				})),
			},
			evaluate,
			signal,
		),
	);
	const retained = candidates.filter((candidate) => selected.has(candidate.id));
	// A semantic proposal cannot discard required evidence to satisfy a context budget.
	// The caller must compact/defer if the unchanged fallback does not fit.
	return retained.reduce((tokens, candidate) => tokens + candidate.tokens, 0) <= maxTokens ? retained : candidates;
}
