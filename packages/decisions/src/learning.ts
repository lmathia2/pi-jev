import { appendFileSync } from "node:fs";
import type { DecisionRequest, Json } from "./contracts.ts";
import { type EvaluationExample, validateEvaluationSplits } from "./evaluation.ts";
import { type PolicyArtifact, parsePolicyArtifact } from "./policy.ts";
import { digestJson } from "./registry.ts";

export interface LearningRecord {
	schemaVersion: 1;
	id: string;
	group: string;
	policyDigest: string;
	inputDigest: string;
	replayable: boolean;
	request?: DecisionRequest;
}

/** Capture requires explicit consent and the exact already-redacted evaluator input. */
export function captureDecision(
	path: string,
	record: Omit<LearningRecord, "schemaVersion" | "inputDigest" | "replayable" | "request">,
	request: DecisionRequest,
	options: { consent: boolean; captureInput: boolean; maxBytes: number },
): LearningRecord | undefined {
	if (!options.consent) return undefined;
	if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error("Invalid capture limit");
	const captured: LearningRecord = {
		id: record.id,
		group: record.group,
		policyDigest: record.policyDigest,
		schemaVersion: 1,
		inputDigest: digestJson(request),
		replayable: options.captureInput,
		...(options.captureInput ? { request: structuredClone(request) } : {}),
	};
	const line = `${JSON.stringify(captured)}\n`;
	if (Buffer.byteLength(line) > options.maxBytes) throw new Error("Learning record exceeds capture limit");
	appendFileSync(path, line, { mode: 0o600 });
	return captured;
}

/** Input columns for jev-align; fixed outcome labels require a matching task contract. */
export function exportJevAlignInputs(examples: readonly EvaluationExample[], split: "train" | "development"): string {
	validateEvaluationSplits(examples);
	if (split !== "train" && split !== "development") throw new Error("Optimizer export cannot include holdout");
	return examples
		.filter((example) => example.split === split)
		.map((example) =>
			JSON.stringify({
				id: example.id,
				group: example.group,
				content: JSON.stringify(example.request),
			}),
		)
		.join("\n");
}

export interface JevAlignContract {
	taskType: "binary" | "multiclass" | "multilabel" | "score";
	outcomeIds: readonly string[];
	maxTextLength: number;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected definition object");
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
	if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
		throw new Error("Definition fields or outcomes changed");
	}
}

/** Import only semantic text. Backend, budget, metrics and permissions are never imported. */
export function importJevAlignDefinition(value: unknown, contract: JevAlignContract): Record<string, Json> {
	if (
		!Number.isInteger(contract.maxTextLength) ||
		contract.maxTextLength < 1 ||
		new Set(contract.outcomeIds).size !== contract.outcomeIds.length ||
		contract.outcomeIds.some((id) => !id.trim())
	) {
		throw new Error("Invalid jev-align contract");
	}
	const definition = object(value);
	const text = (value: unknown): string => {
		if (typeof value !== "string" || !value.trim() || value.length > contract.maxTextLength)
			throw new Error("Invalid definition text");
		return value;
	};
	const instructions = text(definition.instructions);
	if (contract.taskType === "binary") {
		keys(definition, ["instructions", "true_criteria", "false_criteria"]);
		if (contract.outcomeIds.length !== 2) throw new Error("Binary contract requires two outcomes");
		return {
			instructions,
			criteria: {
				[contract.outcomeIds[0]]: text(definition.true_criteria),
				[contract.outcomeIds[1]]: text(definition.false_criteria),
			},
		};
	}
	if (contract.taskType === "multiclass") {
		keys(definition, ["instructions", "criteria"]);
		const criteria = object(definition.criteria);
		keys(criteria, contract.outcomeIds);
		if (contract.outcomeIds.length < 2) throw new Error("Multiclass contract requires at least two outcomes");
		return {
			instructions,
			criteria: Object.fromEntries(Object.entries(criteria).map(([id, value]) => [id, text(value)])),
		};
	}
	if (contract.taskType === "score") {
		keys(definition, ["instructions", "levels"]);
		if (
			!Array.isArray(definition.levels) ||
			definition.levels.length !== contract.outcomeIds.length ||
			definition.levels.length < 2 ||
			definition.levels.length > 10
		)
			throw new Error("Score levels changed");
		return { instructions, levels: definition.levels.map(text) };
	}
	keys(definition, ["instructions", "labels"]);
	const labels = object(definition.labels);
	keys(labels, contract.outcomeIds);
	if (!contract.outcomeIds.length) throw new Error("Multilabel contract requires outcomes");
	return {
		instructions,
		labels: Object.fromEntries(
			Object.entries(labels).map(([id, value]) => {
				const criteria = object(value);
				keys(criteria, ["true_criteria", "false_criteria"]);
				return [id, { true_criteria: text(criteria.true_criteria), false_criteria: text(criteria.false_criteria) }];
			}),
		),
	};
}

/** Produce a new artifact; preserve runtime fields and leave activation to the operator. */
export function importJevAlignPolicy(
	seed: PolicyArtifact,
	acceptedDefinition: unknown,
	contract: JevAlignContract,
	version: string,
): PolicyArtifact {
	const source = parsePolicyArtifact(seed);
	if (version === source.version) throw new Error("Learned policy requires a new immutable version");
	return parsePolicyArtifact({
		...source,
		version,
		policy: { ...source.policy, ...importJevAlignDefinition(acceptedDefinition, contract) },
		provenance: {
			optimizer: "jev-align",
			sourceDigest: digestJson(source),
			definitionDigest: digestJson(acceptedDefinition),
		},
	});
}

export interface PromotionReport {
	policyDigest: string;
	datasetDigest: string;
	split: "holdout";
	examples: number;
	score: number;
	baselineScore: number;
	hardInvariantFailures: number;
}

/** Operator supplies this gate independently of every candidate policy. */
export function canPromote(
	digest: string,
	report: PromotionReport,
	gate: { datasetDigest: string; minExamples: number; minScore: number; maxRegression: number },
): boolean {
	return (
		Boolean(digest && gate.datasetDigest) &&
		digest === report.policyDigest &&
		gate.datasetDigest === report.datasetDigest &&
		report.split === "holdout" &&
		Number.isInteger(report.examples) &&
		Number.isInteger(gate.minExamples) &&
		gate.minExamples > 0 &&
		report.examples >= gate.minExamples &&
		report.hardInvariantFailures === 0 &&
		[report.score, report.baselineScore, gate.minScore, gate.maxRegression].every(Number.isFinite) &&
		gate.maxRegression >= 0 &&
		report.score >= gate.minScore &&
		report.baselineScore - report.score <= gate.maxRegression
	);
}

export interface PolicyRelease {
	activeDigest: string;
	previousDigest?: string;
}

export function promotePolicy(
	release: PolicyRelease,
	digest: string,
	report: PromotionReport,
	gate: Parameters<typeof canPromote>[2],
): PolicyRelease {
	if (!canPromote(digest, report, gate)) throw new Error("Candidate did not pass operator promotion gate");
	if (release.activeDigest === digest) return { ...release };
	return { activeDigest: digest, previousDigest: release.activeDigest };
}

/** Host persists this pointer and applies it only at the next admitted boundary. */
export function rollbackPolicy(release: PolicyRelease): PolicyRelease {
	if (!release.previousDigest) throw new Error("No prior policy release");
	return { activeDigest: release.previousDigest, previousDigest: release.activeDigest };
}
