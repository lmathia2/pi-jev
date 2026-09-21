import assert from "node:assert/strict";
import {
	calibrateNumericParameter,
	compareImplementations,
	DecisionRegistry,
	digestJson,
	type EvaluationExample,
	type EvaluationVariant,
	exportJevAlignInputs,
	groupedSplit,
	importJevAlignPolicy,
	keepCurrentImplementation,
	type PolicyArtifact,
	PolicyStore,
	promotePolicy,
	rollbackPolicy,
	summarizeEvaluation,
} from "../src/index.ts";

// Offline synthetic mechanics check, not an optimizer run or evidence of routing quality.
// Run: node --experimental-strip-types packages/decisions/examples/learning-roundtrip.ts
const registry = new DecisionRegistry();
registry.register(keepCurrentImplementation);
registry.register({
	id: "fixture.routing",
	version: "1",
	definitions: ["generation.route/v1"],
	validatePolicy(policy) {
		assert.equal(typeof policy.instructions, "string");
		assert.equal(typeof policy.threshold, "number");
		assert.ok(Number(policy.threshold) >= 0 && Number(policy.threshold) <= 1);
	},
	async evaluate(request, policy) {
		// Recorded numeric scores stand in for model inference; no text interpretation or API calls.
		return {
			status: "proposed",
			answer: {
				kind: "select",
				candidateId: Number(request.features.score) >= Number(policy.threshold) ? "strong-high" : "cheap-low",
			},
			usage: { requests: 0, costUsd: 0 },
		};
	},
});

const examples: EvaluationExample[] = Array.from({ length: 120 }, (_, index) => {
	const group = `task-${index}`;
	const score = (index % 10) / 10;
	return {
		id: `${group}:phase-1`,
		group,
		split: groupedSplit(group, "roundtrip-v1"),
		request: {
			definition: "generation.route/v1",
			boundaryId: `${group}:phase-1`,
			stateRevision: "1",
			features: { score },
			currentCandidateId: "cheap-low",
			candidates: [
				{ id: "cheap-low", description: "Small model, low reasoning", attributes: {} },
				{ id: "strong-high", description: "Strong model, high reasoning", attributes: {} },
			],
		},
		label: { kind: "select", candidateId: score >= 0.6 ? "strong-high" : "cheap-low" },
	};
});
const development = examples.filter((example) => example.split === "development");
const holdout = examples.filter((example) => example.split === "holdout");
assert.ok(development.length > 0 && holdout.length > 0);
const exported = exportJevAlignInputs(examples, "train");
assert.equal(exported.split("\n").length, examples.filter((example) => example.split === "train").length);
for (const example of holdout) assert.ok(!exported.includes(`"id":"${example.id}"`));

const seed: PolicyArtifact = {
	schemaVersion: 1,
	id: "example/routing",
	version: "1",
	definition: "generation.route/v1",
	implementation: "fixture.routing",
	projectionVersion: "1",
	policy: { instructions: "Select a configured candidate using task fit.", threshold: 0.8 },
};
// This object has the shape of an accepted jev-align artifact's definition field.
const candidate = importJevAlignPolicy(seed, {
	instructions: "Prefer the strong candidate when the task demands sustained reasoning.",
	criteria: { "cheap-low": "Routine bounded work", "strong-high": "Complex reasoning work" },
}, { taskType: "multiclass", outcomeIds: ["cheap-low", "strong-high"], maxTextLength: 1200 }, "2");

function variant(id: string, artifact: PolicyArtifact): EvaluationVariant {
	return {
		id,
		policyDigest: digestJson(artifact),
		invoke: (request, signal) => registry.invoke(artifact.implementation, request, artifact.policy, { signal }),
	};
}

const calibrated = await calibrateNumericParameter([0.4, 0.6, 0.8], { min: 0, max: 1 }, development, async (threshold, rows) => {
	const trial = { ...candidate, policy: { ...candidate.policy, threshold } };
	const result = await compareImplementations(rows, [variant("candidate", trial)], () => true);
	return summarizeEvaluation(result)[0].accuracy ?? 0;
});
candidate.policy.threshold = calibrated.value;
// Freeze policy identity and seal holdout identity before final evaluation; never feed it to calibration.
const candidateDigest = digestJson(candidate);
const datasetDigest = digestJson(holdout);
const baseline = { ...seed, implementation: "baseline.keep-current", policy: {} };
const rows = await compareImplementations(holdout, [variant("baseline", baseline), variant("candidate", candidate)], () => true);
const summaries = summarizeEvaluation(rows);
assert.ok(rows.filter((row) => row.variantId === "candidate").every((row) => row.policyDigest === candidateDigest));
assert.equal(digestJson(candidate), candidateDigest);
assert.equal(digestJson(holdout), datasetDigest);
assert.equal(calibrated.value, 0.6);

const report = {
	policyDigest: candidateDigest,
	datasetDigest,
	split: "holdout" as const,
	examples: holdout.length,
	score: summaries[1].accuracy ?? 0,
	baselineScore: summaries[0].accuracy ?? 0,
	hardInvariantFailures: rows.filter((row) => !row.admitted).length,
};
const release = promotePolicy({ activeDigest: digestJson(seed) }, candidateDigest, report, {
	datasetDigest,
	minExamples: 10,
	minScore: 0.95,
	maxRegression: 0,
});
const store = new PolicyStore((artifact) => registry.validatePolicy(artifact.implementation, artifact.definition, artifact.policy));
store.activate([seed, candidate]);
assert.equal(store.get("example/routing@2")?.digest, release.activeDigest);
const rolledBack = rollbackPolicy(release);
assert.equal(store.get("example/routing@1")?.digest, rolledBack.activeDigest);
console.log(JSON.stringify({
	synthetic: true,
	exportedTrainingRows: exported.split("\n").length,
	developmentRows: development.length,
	holdoutRows: holdout.length,
	calibratedThreshold: calibrated.value,
	comparison: summaries,
	promoted: release.activeDigest,
	rolledBack: rolledBack.activeDigest,
}, null, 2));
