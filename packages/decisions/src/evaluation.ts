import { createHash } from "node:crypto";
import type { DecisionAnswer, DecisionRequest, DecisionResult } from "./contracts.ts";

export interface EvaluationExample {
	id: string;
	group: string;
	split: "train" | "development" | "holdout";
	request: DecisionRequest;
	label?: DecisionAnswer;
}

export interface EvaluationVariant {
	id: string;
	policyDigest: string;
	invoke(
		request: DecisionRequest,
		signal: AbortSignal,
	): Promise<{
		result: DecisionResult;
		elapsedMs: number;
		costUsd: number | null;
	}>;
}

export interface EvaluationRow {
	exampleId: string;
	variantId: string;
	policyDigest: string;
	result: DecisionResult;
	admitted: boolean;
	correct: boolean | null;
	elapsedMs: number;
	costUsd: number | null;
}

export function validateEvaluationSplits(examples: readonly EvaluationExample[]): void {
	const groups = new Map<string, EvaluationExample["split"]>();
	const ids = new Set<string>();
	for (const example of examples) {
		if (
			!example.id ||
			ids.has(example.id) ||
			!example.group ||
			!["train", "development", "holdout"].includes(example.split)
		) {
			throw new Error("Invalid or duplicate evaluation example");
		}
		if (groups.has(example.group) && groups.get(example.group) !== example.split) {
			throw new Error("Task group leaks across evaluation splits");
		}
		groups.set(example.group, example.split);
		ids.add(example.id);
	}
}

/** Proposals only: the common host admission callback must not execute actions. */
export async function compareImplementations(
	examples: readonly EvaluationExample[],
	variants: readonly EvaluationVariant[],
	admit: (request: DecisionRequest, answer: DecisionAnswer) => boolean,
	signal: AbortSignal = new AbortController().signal,
): Promise<EvaluationRow[]> {
	if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
		throw new Error("Duplicate evaluation variant");
	}
	validateEvaluationSplits(examples);
	const rows: EvaluationRow[] = [];
	for (const example of examples) {
		for (const variant of variants) {
			signal.throwIfAborted();
			const started = performance.now();
			let invocation: Awaited<ReturnType<EvaluationVariant["invoke"]>>;
			try {
				const proposed = await variant.invoke(structuredClone(example.request), signal);
				invocation = {
					result: structuredClone(proposed.result),
					elapsedMs: proposed.elapsedMs,
					costUsd: proposed.costUsd,
				};
			} catch {
				invocation = {
					result: { status: "failed", reason: "evaluation_invocation_failed" },
					elapsedMs: performance.now() - started,
					costUsd: null,
				};
			}
			signal.throwIfAborted();
			const { result } = invocation;
			const admitted =
				result.status === "proposed" && admit(structuredClone(example.request), structuredClone(result.answer));
			rows.push({
				exampleId: example.id,
				variantId: variant.id,
				policyDigest: variant.policyDigest,
				result,
				elapsedMs: invocation.elapsedMs,
				costUsd: invocation.costUsd,
				admitted,
				correct: example.label
					? admitted && result.status === "proposed" && answersEqual(result.answer, example.label)
					: null,
			});
		}
	}
	return rows;
}

export function summarizeEvaluation(rows: readonly EvaluationRow[]) {
	const variants = new Map<string, EvaluationRow[]>();
	for (const row of rows) {
		const group = variants.get(row.variantId) ?? [];
		if (group.length && group[0].policyDigest !== row.policyDigest)
			throw new Error("Evaluation variant mixes policy digests");
		group.push(row);
		variants.set(row.variantId, group);
	}
	return [...variants].map(([variantId, group]) => {
		const latencies = group.map((row) => row.elapsedMs).sort((a, b) => a - b);
		const labeled = group.filter((row) => row.correct !== null);
		return {
			variantId,
			examples: group.length,
			accuracy: labeled.length ? labeled.filter((row) => row.correct).length / labeled.length : null,
			abstained: group.filter((row) => row.result.status === "abstained").length,
			failed: group.filter((row) => row.result.status === "failed").length,
			rejected: group.filter((row) => row.result.status === "proposed" && !row.admitted).length,
			p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1],
			p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
			knownCostUsd: group.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
			unknownCostCount: group.filter((row) => row.costUsd === null).length,
		};
	});
}

function answersEqual(actual: DecisionAnswer, expected: DecisionAnswer): boolean {
	if (actual.kind !== expected.kind) return false;
	if (actual.kind === "select" && expected.kind === "select") return actual.candidateId === expected.candidateId;
	if (actual.kind === "subset" && expected.kind === "subset") {
		return JSON.stringify([...actual.candidateIds].sort()) === JSON.stringify([...expected.candidateIds].sort());
	}
	if (actual.kind === "score" && expected.kind === "score") {
		return (
			JSON.stringify(Object.entries(actual.values).sort()) === JSON.stringify(Object.entries(expected.values).sort())
		);
	}
	return false;
}

/** Stable assignment keeps every turn from a task/session in the same split. */
export function groupedSplit(
	group: string,
	seed: string,
	trainFraction = 0.6,
	developmentFraction = 0.2,
): EvaluationExample["split"] {
	if (
		!group ||
		!Number.isFinite(trainFraction) ||
		!Number.isFinite(developmentFraction) ||
		trainFraction < 0 ||
		developmentFraction < 0 ||
		trainFraction + developmentFraction >= 1
	) {
		throw new Error("Invalid grouped split configuration");
	}
	const fraction =
		createHash("sha256")
			.update(JSON.stringify([seed, group]))
			.digest()
			.readUInt32BE(0) /
		2 ** 32;
	return fraction < trainFraction
		? "train"
		: fraction < trainFraction + developmentFraction
			? "development"
			: "holdout";
}

/** Only development scores choose the numeric candidate; holdout stays unseen. */
export async function calibrateNumericParameter(
	values: readonly number[],
	bounds: { min: number; max: number },
	examples: readonly EvaluationExample[],
	evaluate: (value: number, development: readonly EvaluationExample[]) => Promise<number>,
): Promise<{ value: number; score: number }> {
	if (
		!values.length ||
		!Number.isFinite(bounds.min) ||
		!Number.isFinite(bounds.max) ||
		bounds.min > bounds.max ||
		values.some((value) => !Number.isFinite(value) || value < bounds.min || value > bounds.max)
	) {
		throw new Error("Numeric search exceeds operator bounds");
	}
	if (!examples.length || examples.some((example) => example.split !== "development")) {
		throw new Error("Calibration requires development examples only");
	}
	let best = { value: values[0], score: -Infinity };
	for (const value of values) {
		const score = await evaluate(value, structuredClone(examples));
		if (!Number.isFinite(score)) throw new Error("Invalid calibration score");
		if (score > best.score) best = { value, score };
	}
	return best;
}
