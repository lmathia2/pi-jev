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
import { JEV_ROUTE_IDS, type JevFailure, type JevRouteId, type JevRouteResult } from "./types.ts";

const ROUTES: Record<JevRouteId, string> = {
	fast: "A small, direct task that needs little investigation",
	standard: "Ordinary coding work with focused repository inspection and verification",
	deep: "Complex coding or repository analysis requiring broad investigation",
	research: "External research requiring source comparison and citation verification",
};

const MAX_TASK_CHARS = 16_000;

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
