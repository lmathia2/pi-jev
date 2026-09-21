import type { DecisionImplementation, DecisionResult } from "./contracts.ts";
import { defaultDefinitions } from "./registry.ts";

const selections = defaultDefinitions.filter((definition) => definition.answerKind === "select").map(({ id }) => id);

export const keepCurrentImplementation: DecisionImplementation = {
	id: "baseline.keep-current",
	version: "1",
	definitions: [...selections, "context.retention/v1"],
	async evaluate(request) {
		if (request.definition === "context.retention/v1")
			return {
				status: "proposed",
				answer: { kind: "score", values: Object.fromEntries(request.candidates.map(({ id }) => [id, 1])) },
				usage: { requests: 0, costUsd: 0 },
			};
		return request.currentCandidateId
			? {
					status: "proposed",
					answer: { kind: "select", candidateId: request.currentCandidateId },
					usage: { requests: 0, costUsd: 0 },
				}
			: { status: "abstained", reason: "no-current-candidate", usage: { requests: 0, costUsd: 0 } };
	},
};

/** Candidate metrics are supplied by the host; policy weights can be calibrated offline. */
export const heuristicImplementation: DecisionImplementation = {
	id: "heuristic.weighted",
	version: "1",
	definitions: selections,
	validatePolicy(policy) {
		if (
			!policy.weights ||
			typeof policy.weights !== "object" ||
			Array.isArray(policy.weights) ||
			Object.values(policy.weights).some((weight) => typeof weight !== "number" || !Number.isFinite(weight))
		) {
			throw new Error("weights must contain finite numbers");
		}
	},
	async evaluate(request, policy) {
		const weights = policy.weights as Record<string, number>;
		let winner = request.currentCandidateId;
		let best = -Infinity;
		for (const candidate of request.candidates) {
			let score = 0;
			let complete = true;
			for (const [key, weight] of Object.entries(weights)) {
				const value = candidate.attributes[key];
				if (typeof value !== "number") {
					complete = false;
					break;
				}
				score += value * weight;
			}
			if (
				complete &&
				Number.isFinite(score) &&
				(score > best || (score === best && candidate.id === request.currentCandidateId))
			) {
				winner = candidate.id;
				best = score;
			}
		}
		return winner && best !== -Infinity
			? { status: "proposed", answer: { kind: "select", candidateId: winner }, usage: { requests: 0, costUsd: 0 } }
			: { status: "abstained", reason: "missing-metrics", usage: { requests: 0, costUsd: 0 } };
	},
};

export function recordedImplementation(
	id: string,
	responses: Readonly<Record<string, DecisionResult>>,
): DecisionImplementation {
	const recorded = structuredClone(responses);
	return {
		id,
		version: "1",
		definitions: defaultDefinitions.map((definition) => definition.id),
		async evaluate(request) {
			return structuredClone(recorded[request.boundaryId] ?? { status: "abstained", reason: "missing-recording" });
		},
	};
}
