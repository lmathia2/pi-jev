import { createHash } from "node:crypto";
import type {
	DecisionDefinition,
	DecisionImplementation,
	DecisionInvocation,
	DecisionRequest,
	DecisionResult,
	Json,
} from "./contracts.ts";

/** Reject non-JSON input rather than silently dropping fields from replay identities. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	throw new Error("Decision data must contain finite JSON values only");
}

export function digestJson(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export const defaultDefinitions: readonly DecisionDefinition[] = [
	...["generation.phase/v1", "generation.route/v1", "tools.profile/v1", "tools.review/v1", "completion.verify/v1"].map(
		(id) => ({
			id,
			answerKind: "select" as const,
		}),
	),
	...["context.select/v1", "output.select/v1", "skills.select/v1", "retrieval.rank/v1"].map((id) => ({
		id,
		answerKind: "subset" as const,
	})),
	{
		id: "context.retention/v1",
		answerKind: "score",
		validate: (request, answer) =>
			answer.kind === "score" &&
			Object.keys(answer.values).length === request.candidates.length &&
			Object.values(answer.values).every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
	},
];

export interface InvocationOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxInputBytes?: number;
	maxCandidates?: number;
	/** Shared invocation allowance. Reserved synchronously before plugin execution. */
	budget?: { remaining: number };
	/** Admission cap for reported cost. Transport-level spending caps remain the host's responsibility. */
	maxCostUsd?: number;
}

export class DecisionRegistry {
	private implementations = new Map<string, DecisionImplementation>();
	private definitions: Map<string, DecisionDefinition>;

	constructor(definitions: readonly DecisionDefinition[] = defaultDefinitions) {
		this.definitions = new Map();
		for (const definition of definitions) {
			if (this.definitions.has(definition.id)) throw new Error(`Duplicate definition: ${definition.id}`);
			this.definitions.set(definition.id, { ...definition });
		}
	}

	register(implementation: DecisionImplementation): void {
		if (!implementation.id || !implementation.version || this.implementations.has(implementation.id)) {
			throw new Error(`Invalid or duplicate implementation: ${implementation.id}`);
		}
		if (!implementation.definitions.length || implementation.definitions.some((id) => !this.definitions.has(id))) {
			throw new Error(`Unsupported definition in ${implementation.id}`);
		}
		this.implementations.set(implementation.id, {
			...implementation,
			definitions: [...implementation.definitions],
		});
	}

	validatePolicy(implementationId: string, definition: string, policy: Readonly<Record<string, Json>>): void {
		canonicalJson(policy);
		const implementation = this.implementations.get(implementationId);
		if (!implementation?.definitions.includes(definition))
			throw new Error("Unsupported implementation or definition");
		implementation.validatePolicy?.(structuredClone(policy));
	}

	async invoke(
		implementationId: string,
		requestInput: DecisionRequest,
		policyInput: Readonly<Record<string, Json>> = {},
		options: InvocationOptions = {},
	): Promise<DecisionInvocation> {
		const start = performance.now();
		const implementation = this.implementations.get(implementationId);
		const invocation: DecisionInvocation = {
			result: { status: "failed", reason: "invalid-input" },
			implementationId,
			implementationVersion: implementation?.version ?? "unknown",
			inputDigest: "",
			policyDigest: "",
			elapsedMs: 0,
			requestCount: 0,
			costUsd: null,
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		const abort = () => controller.abort();
		let onAbort: (() => void) | undefined;
		let started = false;
		try {
			// Capture once before yielding: identity, evaluation and validation refer to the same input.
			const request = structuredClone(requestInput);
			const policy = structuredClone(policyInput);
			invocation.inputDigest = digestJson(request);
			invocation.policyDigest = digestJson(policy);
			const maxInputBytes = options.maxInputBytes ?? 1024 * 1024;
			const maxCandidates = options.maxCandidates ?? 1024;
			if (
				!Number.isSafeInteger(maxInputBytes) ||
				maxInputBytes < 1 ||
				!Number.isSafeInteger(maxCandidates) ||
				maxCandidates < 1 ||
				Buffer.byteLength(canonicalJson(request)) + Buffer.byteLength(canonicalJson(policy)) > maxInputBytes ||
				!Array.isArray(request.candidates) ||
				request.candidates.length > maxCandidates ||
				typeof request.features !== "object" ||
				request.features === null ||
				Array.isArray(request.features) ||
				typeof policy !== "object" ||
				policy === null ||
				Array.isArray(policy) ||
				request.candidates.some(
					(candidate) =>
						!candidate ||
						typeof candidate.id !== "string" ||
						typeof candidate.description !== "string" ||
						typeof candidate.attributes !== "object" ||
						candidate.attributes === null ||
						Array.isArray(candidate.attributes),
				)
			)
				return invocation;
			const definition = this.definitions.get(request.definition);
			const ids = request.candidates.map((candidate) => candidate.id);
			if (
				!definition ||
				typeof request.boundaryId !== "string" ||
				!request.boundaryId ||
				typeof request.stateRevision !== "string" ||
				!request.stateRevision ||
				!ids.length ||
				ids.some((id) => !id) ||
				new Set(ids).size !== ids.length ||
				(request.currentCandidateId !== undefined && !ids.includes(request.currentCandidateId))
			)
				return invocation;
			if (!implementation || !implementation.definitions.includes(request.definition)) {
				invocation.result = { status: "failed", reason: "unsupported-implementation" };
				return invocation;
			}
			if (options.signal?.aborted) {
				invocation.result = { status: "abstained", reason: "cancelled" };
				return invocation;
			}
			if (options.budget && (!Number.isInteger(options.budget.remaining) || options.budget.remaining <= 0)) {
				invocation.result = { status: "abstained", reason: "budget-exhausted" };
				return invocation;
			}
			const timeoutMs = options.timeoutMs ?? 5000;
			if (
				!Number.isFinite(timeoutMs) ||
				timeoutMs <= 0 ||
				(options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0))
			) {
				return invocation;
			}
			const isolatedPolicy = structuredClone(policy);
			implementation.validatePolicy?.(structuredClone(isolatedPolicy));
			if (options.signal?.aborted) {
				invocation.result = { status: "abstained", reason: "cancelled" };
				return invocation;
			}
			if (options.budget) options.budget.remaining--;
			options.signal?.addEventListener("abort", abort, { once: true });
			const stopped = new Promise<DecisionResult>((resolve) => {
				onAbort = () => resolve({ status: "abstained", reason: "cancelled" });
				controller.signal.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(() => {
					resolve({ status: "failed", reason: "timeout" });
					controller.abort();
				}, timeoutMs);
			});
			const result = await Promise.race([
				Promise.resolve().then((): Promise<DecisionResult> | DecisionResult => {
					if (controller.signal.aborted) return { status: "abstained", reason: "cancelled" };
					started = true;
					return implementation.evaluate(structuredClone(request), isolatedPolicy, controller.signal);
				}),
				stopped,
			]);
			canonicalJson(result);
			if (result.usage) {
				if (
					!Number.isInteger(result.usage.requests) ||
					result.usage.requests < 0 ||
					(result.usage.tokens !== undefined &&
						(!Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0)) ||
					(result.usage.costUsd !== undefined &&
						(!Number.isFinite(result.usage.costUsd) || result.usage.costUsd < 0))
				) {
					invocation.result = { status: "failed", reason: "invalid-usage" };
					return invocation;
				}
				invocation.requestCount = result.usage.requests;
				invocation.costUsd = result.usage.costUsd ?? null;
			}
			if (options.signal?.aborted) {
				invocation.result = { status: "abstained", reason: "cancelled" };
			} else if (
				result.status === "proposed" &&
				options.maxCostUsd !== undefined &&
				(invocation.costUsd === null || invocation.costUsd > options.maxCostUsd)
			) {
				invocation.result = { status: "abstained", reason: "cost-limit" };
			} else if (result.status === "proposed") {
				const answer = result.answer;
				const selected =
					answer.kind === "select"
						? [answer.candidateId]
						: answer.kind === "subset"
							? answer.candidateIds
							: answer.kind === "score"
								? Object.keys(answer.values)
								: [];
				const valid =
					answer.kind === definition.answerKind &&
					Array.isArray(selected) &&
					selected.every((id) => ids.includes(id)) &&
					new Set(selected).size === selected.length &&
					(answer.kind !== "score" || Object.values(answer.values).every(Number.isFinite)) &&
					(!definition.validate || definition.validate(structuredClone(request), answer));
				invocation.result = valid ? structuredClone(result) : { status: "failed", reason: "invalid-answer" };
			} else {
				invocation.result =
					(result.status === "failed" || result.status === "abstained") && typeof result.reason === "string"
						? structuredClone(result)
						: { status: "failed", reason: "invalid-result" };
			}
		} catch {
			invocation.result = { status: "failed", reason: started ? "implementation-error" : "invalid-input" };
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (onAbort) controller.signal.removeEventListener("abort", onAbort);
			invocation.elapsedMs = performance.now() - start;
		}
		return invocation;
	}
}
