/**
 * Compose this factory with an existing retrieval plugin. Its search callback owns
 * source access and required evidence; the decision implementation only ranks.
 */
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { DecisionImplementation, Json } from "@earendil-works/pi-decisions";
import { DecisionRegistry } from "@earendil-works/pi-decisions";
import { Type } from "typebox";
import { type RetrievedDecisionCandidate, selectRetrievedContext } from "../../src/jev/decision-selection.ts";

export function createDecisionRetrievalExtension(options: {
	implementation: DecisionImplementation;
	policy: Record<string, Json>;
	maxTokens: number;
	search(
		query: string,
		context: ExtensionContext,
		signal?: AbortSignal,
	): Promise<readonly RetrievedDecisionCandidate[]>;
}): InlineExtension {
	const registry = new DecisionRegistry();
	registry.register(options.implementation);
	registry.validatePolicy(options.implementation.id, "retrieval.rank/v1", options.policy);
	return {
		name: "decision-retrieval",
		factory(pi) {
			pi.registerTool({
				name: "search_context",
				label: "Search context",
				description:
					"Search an existing source index and rank excerpts. Excerpts guide focused reads; verify original sources before citing them.",
				parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 8000 }) }),
				async execute(id, args, signal, _update, context) {
					const candidates = await options.search(args.query, context, signal);
					const selected = await selectRetrievedContext(
						candidates,
						options.maxTokens,
						{
							boundaryId: id,
							stateRevision: context.sessionManager.getLeafId() ?? "",
							features: { query: args.query, pendingInput: context.hasPendingMessages() },
						},
						async (request, abort) =>
							(
								await registry.invoke(options.implementation.id, request, options.policy, {
									signal: abort,
									timeoutMs: 5000,
								})
							).result,
						signal,
					);
					return {
						content: [
							{
								type: "text",
								text: selected
									.map((candidate) => `${candidate.id}: ${candidate.label}\n${candidate.excerpt}`)
									.join("\n\n"),
							},
						],
						details: { sources: selected.map((candidate) => candidate.id) },
					};
				},
			});
		},
	};
}
