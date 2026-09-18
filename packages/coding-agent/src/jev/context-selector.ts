import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { findJevCandidates } from "./client.ts";
import type { ContextCandidate } from "./types.ts";

export interface JevContextSelectorOptions {
	client: TypeSafeClient;
	maxOptional?: number;
	minFit?: number;
	timeoutMs?: number;
}

export async function selectJevContext(
	query: string,
	candidates: readonly ContextCandidate[],
	options: JevContextSelectorOptions,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
		return candidates.map((candidate) => candidate.id);
	}
	const required = candidates.filter((candidate) => candidate.required).map((candidate) => candidate.id);
	const optional = candidates.filter((candidate) => !candidate.required);
	if (optional.length === 0) return required;
	const result = await findJevCandidates(
		options.client,
		query,
		optional.map((candidate) => ({
			id: candidate.id,
			description: `${candidate.source}: ${candidate.label}\n${candidate.excerpt.slice(0, 2_000)}`,
		})),
		{ signal, timeoutMs: options.timeoutMs ?? 5_000 },
	);
	if (!result.ok || result.fit < (options.minFit ?? 0.7)) return candidates.map((candidate) => candidate.id);
	const indexes = new Map(candidates.map((candidate, index) => [candidate.id, index]));
	const selectedOptional = optional
		.map((candidate) => ({ candidate, relevance: result.relevance[candidate.id] ?? 0 }))
		.sort(
			(left, right) =>
				right.relevance - left.relevance ||
				(indexes.get(left.candidate.id) ?? 0) - (indexes.get(right.candidate.id) ?? 0),
		)
		.slice(0, options.maxOptional ?? 4)
		.map(({ candidate }) => candidate.id);
	const selected = new Set([...required, ...selectedOptional]);
	return candidates.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.id);
}
