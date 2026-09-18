import {
	APIConnectionError,
	APIError,
	APITimeoutError,
	APIUserAbortError,
	choice,
	type Fetch,
	InternalServerError,
	noul,
	RateLimitError,
	TypeSafeClient,
} from "@typesafe-ai/sdk";
import {
	JEV_ROUTE_IDS,
	type JevCandidate,
	type JevFailure,
	type JevFindResult,
	type JevRouteId,
	type JevRouteResult,
	type JevSelectionResult,
} from "./types.ts";

const ROUTES: Record<JevRouteId, string> = {
	fast: "A small, direct task that needs little investigation",
	standard: "Ordinary coding work with focused repository inspection and verification",
	deep: "Complex coding or repository analysis requiring broad investigation",
	research: "External research requiring source comparison and citation verification",
};

const MAX_TASK_CHARS = 16_000;
const MAX_CANDIDATES = 255;

export function createJevClient(options: {
	apiKey: string;
	baseURL?: string;
	fetch?: Fetch;
	timeoutMs: number;
}): TypeSafeClient {
	return new TypeSafeClient({
		apiKey: options.apiKey,
		baseURL: options.baseURL,
		fetch: options.fetch,
		logLevel: "off",
		timeout: options.timeoutMs,
	});
}

export async function decideJevRoute(
	client: TypeSafeClient,
	task: string,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<JevRouteResult> {
	const startedAt = performance.now();
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	try {
		const response = await client.systemOne(
			{
				state: { task: task.slice(0, MAX_TASK_CHARS) },
				questions: {
					route: choice("Which route best matches the next agent run?", ROUTES),
					fits: noul("Does the selected route fit the task?", {
						true: "The route matches the task's required work",
						false: "None of the routes adequately matches the task",
					}),
				},
			},
			{ signal },
		);
		const route = response.answers.route.choice;
		if (
			!JEV_ROUTE_IDS.includes(route) ||
			!Number.isFinite(response.answers.route.confidence) ||
			!Number.isFinite(response.answers.fits.noul) ||
			JEV_ROUTE_IDS.some((id) => !Number.isFinite(response.answers.route.probabilities[id]))
		) {
			return { ok: false, failure: "invalid_response", durationMs: performance.now() - startedAt };
		}
		return {
			ok: true,
			decision: {
				route,
				confidence: response.answers.route.confidence,
				fit: response.answers.fits.noul,
				probabilities: response.answers.route.probabilities,
				model: response.model,
				usage: response.usage,
			},
			durationMs: performance.now() - startedAt,
		};
	} catch (error) {
		return {
			ok: false,
			failure: classifyJevFailure(error, options.signal, timeoutSignal),
			durationMs: performance.now() - startedAt,
		};
	}
}

export async function selectJevCandidate(
	client: TypeSafeClient,
	task: string,
	candidates: readonly JevCandidate[],
	options: { signal?: AbortSignal; timeoutMs: number; minProbability?: number; minFit?: number },
): Promise<JevSelectionResult> {
	if (candidates.length === 0) return { ok: false, failure: "no_candidates" };
	if (
		candidates.length > MAX_CANDIDATES ||
		new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
	) {
		return { ok: false, failure: "invalid_response" };
	}
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	try {
		if (candidates.length === 1) {
			const response = await client.systemOne(
				{
					state: {
						task: task.slice(0, MAX_TASK_CHARS),
						candidate: { id: candidates[0].id, description: candidates[0].description },
					},
					questions: {
						fits: noul("Does the candidate fit the task?", {
							true: "The candidate directly applies",
							false: "The candidate does not apply",
						}),
					},
				},
				{ signal },
			);
			const fit = response.answers.fits.noul;
			if (!Number.isFinite(fit)) return { ok: false, failure: "invalid_response" };
			if (fit < (options.minFit ?? 0.7)) return { ok: false, failure: "rejected" };
			return { ok: true, id: candidates[0].id, probability: 1, fit };
		}
		const labeledCandidates = candidates.map((candidate, index) => ({
			label: candidateLabel(index),
			candidate,
		}));
		const criteria = Object.fromEntries(labeledCandidates.map(({ label }) => [label, null]));
		const broad = await client.systemOne(
			{
				state: {
					task: task.slice(0, MAX_TASK_CHARS),
					candidates: labeledCandidates.map(({ label, candidate }) => ({
						label,
						id: candidate.id,
						description: candidate.description,
					})),
				},
				questions: { candidate: choice("Which candidate best matches the task?", criteria) },
			},
			{ signal },
		);
		if (labeledCandidates.some(({ label }) => !Number.isFinite(broad.answers.candidate.probabilities[label]))) {
			return { ok: false, failure: "invalid_response" };
		}
		const shortlist = labeledCandidates
			.map(({ candidate, label }, index) => ({
				candidate,
				index,
				probability: broad.answers.candidate.probabilities[label],
			}))
			.sort((left, right) => right.probability - left.probability || left.index - right.index)
			.slice(0, 3)
			.map(({ candidate }) => candidate);
		const labeledShortlist = shortlist.map((candidate, index) => ({ label: candidateLabel(index), candidate }));
		const shortlistCriteria = Object.fromEntries(labeledShortlist.map(({ label }) => [label, null]));
		const reranked = await client.systemOne(
			{
				state: {
					task: task.slice(0, MAX_TASK_CHARS),
					candidates: labeledShortlist.map(({ label, candidate }) => ({
						label,
						id: candidate.id,
						description: candidate.description,
					})),
				},
				questions: {
					candidate: choice("Which shortlisted candidate best matches the task?", shortlistCriteria),
					fits: noul("Does the selected candidate fit the task?", {
						true: "The candidate directly applies",
						false: "No candidate applies",
					}),
				},
			},
			{ signal },
		);
		const selected = labeledShortlist.find(({ label }) => label === reranked.answers.candidate.choice);
		const probability = selected ? reranked.answers.candidate.probabilities[selected.label] : Number.NaN;
		const fit = reranked.answers.fits.noul;
		if (
			selected === undefined ||
			labeledShortlist.some(({ label }) => !Number.isFinite(reranked.answers.candidate.probabilities[label])) ||
			!Number.isFinite(probability) ||
			!Number.isFinite(fit)
		) {
			return { ok: false, failure: "invalid_response" };
		}
		if (probability < (options.minProbability ?? 0.7) || fit < (options.minFit ?? 0.7)) {
			return { ok: false, failure: "rejected" };
		}
		return { ok: true, id: selected.candidate.id, probability, fit };
	} catch (error) {
		return { ok: false, failure: classifyJevFailure(error, options.signal, timeoutSignal) };
	}
}

export async function findJevCandidates(
	client: TypeSafeClient,
	query: string,
	candidates: readonly JevCandidate[],
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<JevFindResult> {
	if (candidates.length === 0) return { ok: false, failure: "no_candidates" };
	if (
		candidates.length > MAX_CANDIDATES ||
		new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
	) {
		return { ok: false, failure: "invalid_response" };
	}
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	try {
		if (candidates.length === 1) {
			const response = await client.systemOne(
				{
					state: {
						query: query.slice(0, MAX_TASK_CHARS),
						candidate: { id: candidates[0].id, description: candidates[0].description },
					},
					questions: {
						exists: noul("Does the candidate address the query?", {
							true: "The candidate states or directly implies an answer",
							false: "The candidate does not address the query",
						}),
					},
				},
				{ signal },
			);
			const fit = response.answers.exists.noul;
			if (!Number.isFinite(fit)) return { ok: false, failure: "invalid_response" };
			return { ok: true, relevance: { [candidates[0].id]: 1 }, fit };
		}
		const labeledCandidates = candidates.map((candidate, index) => ({
			label: candidateLabel(index),
			candidate,
		}));
		const criteria = Object.fromEntries(labeledCandidates.map(({ label }) => [label, null]));
		const response = await client.systemOne(
			{
				state: {
					query: query.slice(0, MAX_TASK_CHARS),
					candidates: labeledCandidates.map(({ label, candidate }) => ({
						label,
						id: candidate.id,
						description: candidate.description,
					})),
				},
				questions: {
					where: choice("Which candidate best addresses the query?", criteria),
					exists: noul("Does any candidate address the query?", {
						true: "At least one candidate states or directly implies an answer",
						false: "No candidate addresses the query",
					}),
				},
			},
			{ signal },
		);
		const relevance = Object.fromEntries(
			labeledCandidates.map(({ label, candidate }) => [candidate.id, response.answers.where.probabilities[label]]),
		);
		const fit = response.answers.exists.noul;
		if (Object.values(relevance).some((probability) => !Number.isFinite(probability)) || !Number.isFinite(fit)) {
			return { ok: false, failure: "invalid_response" };
		}
		return { ok: true, relevance, fit };
	} catch (error) {
		return { ok: false, failure: classifyJevFailure(error, options.signal, timeoutSignal) };
	}
}

function candidateLabel(index: number): string {
	return `candidate_${index.toString().padStart(3, "0")}`;
}

function classifyJevFailure(
	error: unknown,
	callerSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal,
): JevFailure {
	if (callerSignal?.aborted) return "aborted";
	if (timeoutSignal.aborted || error instanceof APITimeoutError) return "timeout";
	if (error instanceof RateLimitError || (error instanceof APIError && error.status === 429)) return "rate_limit";
	if (error instanceof InternalServerError || (error instanceof APIError && error.status >= 500)) return "service";
	if (error instanceof APIUserAbortError) return "aborted";
	if (error instanceof APIConnectionError) return "unavailable";
	return "invalid_response";
}
