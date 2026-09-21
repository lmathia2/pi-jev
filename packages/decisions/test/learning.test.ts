import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { DecisionRequest, DecisionResult } from "../src/contracts.ts";
import {
	calibrateNumericParameter,
	compareImplementations,
	type EvaluationExample,
	groupedSplit,
	summarizeEvaluation,
} from "../src/evaluation.ts";
import {
	canPromote,
	captureDecision,
	exportJevAlignInputs,
	importJevAlignDefinition,
	importJevAlignPolicy,
	promotePolicy,
	rollbackPolicy,
} from "../src/learning.ts";

const request: DecisionRequest = {
	definition: "generation.route/v1",
	boundaryId: "phase-1",
	stateRevision: "1",
	features: { privateFact: "redacted" },
	currentCandidateId: "a",
	candidates: [
		{ id: "a", description: "current", attributes: {} },
		{ id: "b", description: "alternative", attributes: {} },
	],
};
const example: EvaluationExample = {
	id: "row-1",
	group: "task-1",
	split: "development",
	request,
	label: { kind: "select", candidateId: "a" },
};

test("paired evaluation isolates mutations, shares admission, and never attributes unlabeled outcomes", async () => {
	const rows = await compareImplementations(
		[example, { ...example, id: "unlabeled", label: undefined }],
		[
			{
				id: "mutator",
				policyDigest: "v1",
				invoke: async (input) => {
					(input.features as Record<string, string>).privateFact = "mutated";
					return {
						result: { status: "proposed", answer: { kind: "select", candidateId: "missing" } },
						elapsedMs: 1,
						costUsd: null,
					};
				},
			},
			{
				id: "baseline",
				policyDigest: "v2",
				invoke: async (input) => {
					assert.equal(input.features.privateFact, "redacted");
					return {
						result: { status: "proposed", answer: { kind: "select", candidateId: "a" } },
						elapsedMs: 1,
						costUsd: 0,
					};
				},
			},
		],
		(input, answer) =>
			answer.kind === "select" && input.candidates.some((candidate) => candidate.id === answer.candidateId),
	);
	assert.deepEqual(
		rows.map((row) => [row.admitted, row.correct]),
		[
			[false, false],
			[true, true],
			[false, null],
			[true, null],
		],
	);
	assert.equal(request.features.privateFact, "redacted");
	assert.equal(rows[0].costUsd, null);
	assert.deepEqual(
		summarizeEvaluation(rows).map((summary) => [summary.variantId, summary.accuracy, summary.unknownCostCount]),
		[
			["mutator", 0, 2],
			["baseline", 1, 0],
		],
	);
});

test("capture is opt-in, metadata cannot replay, and heldout inputs never enter optimizer export", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-learning-"));
	try {
		const path = join(directory, "records.jsonl");
		const metadata = { id: "row-1", group: "task-1", policyDigest: "p1" };
		assert.equal(
			captureDecision(path, metadata, request, { consent: false, captureInput: true, maxBytes: 10000 }),
			undefined,
		);
		captureDecision(path, metadata, request, { consent: true, captureInput: false, maxBytes: 10000 });
		assert.equal(readFileSync(path, "utf8").includes("privateFact"), false);
		const record = captureDecision(path, metadata, request, { consent: true, captureInput: true, maxBytes: 10000 });
		assert.deepEqual(record?.request, request);
		assert.equal(record?.replayable, true);
		assert.throws(() => captureDecision(path, metadata, request, { consent: true, captureInput: true, maxBytes: 1 }));
		const exported = exportJevAlignInputs(
			[
				{ ...example, split: "train" },
				{ ...example, id: "secret-holdout", group: "heldout-task", split: "holdout" },
			],
			"train",
		);
		assert.equal(exported.includes("secret-holdout"), false);
		assert.deepEqual(JSON.parse(JSON.parse(exported).content), request);
		assert.throws(() =>
			exportJevAlignInputs(
				[
					{ ...example, split: "train" },
					{ ...example, id: "leaked", split: "holdout" },
				],
				"train",
			),
		);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("comparison snapshots results and rejects summaries combining policy versions", async () => {
	const shared: DecisionResult = { status: "proposed", answer: { kind: "select", candidateId: "a" } };
	let calls = 0;
	const rows = await compareImplementations(
		[example, { ...example, id: "second" }],
		[
			{
				id: "reused-result",
				policyDigest: "v1",
				invoke: async () => {
					shared.answer = { kind: "select", candidateId: calls++ === 0 ? "a" : "b" };
					return { result: shared, elapsedMs: 0, costUsd: 0 };
				},
			},
		],
		(_request, answer) => {
			if (answer.kind === "select") answer.candidateId = "mutated-by-admission";
			return true;
		},
	);
	assert.deepEqual(
		rows.map((row) => [row.result, row.correct]),
		[
			[{ status: "proposed", answer: { kind: "select", candidateId: "a" } }, true],
			[{ status: "proposed", answer: { kind: "select", candidateId: "b" } }, false],
		],
	);
	assert.throws(() => summarizeEvaluation([rows[0], { ...rows[1], policyDigest: "v2" }]), /mixes policy digests/);
});

test("accepted jev-align text imports preserve outcomes and reject executable/operator fields", () => {
	const contract = { taskType: "multiclass" as const, outcomeIds: ["a", "b"], maxTextLength: 100 };
	const definition = { instructions: "Choose task fit", criteria: { a: "Simple task", b: "Hard task" } };
	assert.deepEqual(importJevAlignDefinition(definition, contract), definition);
	const seed = {
		schemaVersion: 1 as const,
		id: "routing",
		version: "1",
		definition: "generation.route/v1",
		implementation: "jev.typed",
		projectionVersion: "1",
		policy: { instructions: "seed", minProbability: 0.8 },
	};
	const learned = importJevAlignPolicy(seed, definition, contract, "2");
	assert.equal(learned.policy.minProbability, 0.8);
	assert.equal(learned.policy.instructions, "Choose task fit");
	assert.equal(seed.policy.instructions, "seed");
	assert.throws(() => importJevAlignPolicy(seed, definition, contract, "1"));
	assert.throws(() => importJevAlignDefinition({ ...definition, maxSpend: 1000 }, contract));
	assert.throws(() => importJevAlignDefinition({ ...definition, criteria: { a: "Only one" } }, contract));
	assert.throws(() => importJevAlignDefinition({ ...definition, instructions: "x".repeat(101) }, contract));
	assert.deepEqual(
		importJevAlignDefinition(
			{ instructions: "Judge", true_criteria: "Supported", false_criteria: "Unsupported" },
			{ ...contract, taskType: "binary" },
		),
		{
			instructions: "Judge",
			criteria: { a: "Supported", b: "Unsupported" },
		},
	);
	assert.deepEqual(
		importJevAlignDefinition({ instructions: "Score", levels: ["low", "high"] }, { ...contract, taskType: "score" }),
		{ instructions: "Score", levels: ["low", "high"] },
	);
});

test("numeric calibration keeps holdout sealed; grouped assignment remains stable", async () => {
	assert.equal(groupedSplit("task-1", "seed"), groupedSplit("task-1", "seed"));
	const splits = new Set(Array.from({ length: 100 }, (_, index) => groupedSplit(`task-${index}`, "seed")));
	assert.equal(splits.size, 3);
	assert.deepEqual(
		await calibrateNumericParameter(
			[0.1, 0.5, 0.9],
			{ min: 0, max: 1 },
			[example],
			async (value) => 1 - Math.abs(value - 0.5),
		),
		{ value: 0.5, score: 1 },
	);
	await assert.rejects(
		calibrateNumericParameter([0.5], { min: 0, max: 1 }, [{ ...example, split: "holdout" }], async () => 1),
	);
	await assert.rejects(calibrateNumericParameter([2], { min: 0, max: 1 }, [example], async () => 1));
});

test("artifact round trip needs digest-bound heldout gate and explicit activation with rollback", () => {
	const report = {
		policyDigest: "new",
		datasetDigest: "sealed",
		split: "holdout" as const,
		examples: 100,
		score: 0.9,
		baselineScore: 0.9,
		hardInvariantFailures: 0,
	};
	const gate = { datasetDigest: "sealed", minExamples: 50, minScore: 0.85, maxRegression: 0 };
	assert.equal(canPromote("new", report, gate), true);
	assert.equal(canPromote("different", report, gate), false);
	assert.equal(canPromote("new", { ...report, hardInvariantFailures: 1 }, gate), false);
	assert.equal(canPromote("new", { ...report, score: NaN }, gate), false);
	assert.equal(canPromote("new", { ...report, datasetDigest: "training" }, gate), false);
	const release = promotePolicy({ activeDigest: "old" }, "new", report, gate);
	assert.deepEqual(release, { activeDigest: "new", previousDigest: "old" });
	assert.deepEqual(promotePolicy(release, "new", report, gate), release);
	assert.equal(rollbackPolicy(release).activeDigest, "old");
});
