import type { HookHandler, LaneConfiguration } from "@earendil-works/pi-agent-core";
import type {
	Candidate,
	DecisionRegistry,
	DecisionRequest,
	InvocationOptions,
	ResolvedPolicy,
} from "@earendil-works/pi-decisions";

type GenerationEvent = Parameters<HookHandler<"before_generation">>[0];
type GenerationContext = Parameters<HookHandler<"before_generation">>[1];

export interface DurableDecisionRouterOptions {
	registry: DecisionRegistry;
	policy: ResolvedPolicy;
	routes: Readonly<Record<string, LaneConfiguration>>;
	invocation?: Omit<InvocationOptions, "signal">;
	/** Host owns admitted phases and branch/restart state; undefined keeps its current route. */
	buildRequest(
		event: GenerationEvent,
		context: GenerationContext,
	): DecisionRequest | undefined | Promise<DecisionRequest | undefined>;
	/** Recheck live revision, overrides, availability and cache economics immediately before returning. */
	admit(
		request: DecisionRequest,
		candidate: Candidate,
		event: GenerationEvent,
		context: GenerationContext,
	): boolean | Promise<boolean>;
}

/** The durable driver persists the returned complete configuration before provider admission and reuses it on retry. */
export function createDecisionGenerationRouter(
	options: DurableDecisionRouterOptions,
): HookHandler<"before_generation"> {
	const policy = structuredClone(options.policy);
	const routes = structuredClone(options.routes);
	return async (event, context) => {
		if (event.attempt !== 1 || context.abortSignal?.aborted) return undefined;
		const request = await options.buildRequest(event, context);
		if (
			!request ||
			request.definition !== "generation.route/v1" ||
			policy.artifact.definition !== request.definition ||
			context.abortSignal?.aborted
		)
			return undefined;
		const invocation = await options.registry.invoke(
			policy.artifact.implementation,
			request,
			policy.artifact.policy,
			{
				...options.invocation,
				signal: context.abortSignal,
			},
		);
		const result = invocation.result;
		if (result.status !== "proposed" || result.answer.kind !== "select" || context.abortSignal?.aborted)
			return undefined;
		const selectedId = result.answer.candidateId;
		const candidate = request.candidates.find((candidate) => candidate.id === selectedId);
		const configuration = Object.hasOwn(routes, selectedId) ? routes[selectedId] : undefined;
		if (
			!candidate ||
			!configuration ||
			!(await options.admit(request, candidate, event, context)) ||
			context.abortSignal?.aborted
		)
			return undefined;
		return { configuration: structuredClone(configuration) };
	};
}
