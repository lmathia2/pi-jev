import { APIError, APITimeoutError, choice, noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import type { DecisionImplementation, DecisionResult, Json } from "./contracts.ts";

const subsetDefinitions = ["context.select/v1", "output.select/v1", "skills.select/v1", "retrieval.rank/v1"];

/** Credentials and transport belong to the caller; importing core never loads this adapter. */
export function createJevImplementation(client: Pick<TypeSafeClient, "systemOne">): DecisionImplementation {
	return {
		id: "jev.typed",
		version: "1",
		definitions: [
			"generation.phase/v1",
			"generation.route/v1",
			"tools.profile/v1",
			"tools.review/v1",
			"completion.verify/v1",
			"recovery.action/v1",
			"specialist.select/v1",
			"evidence.verify/v1",
			"context.retention/v1",
			...subsetDefinitions,
		],
		validatePolicy(policy) {
			if (Object.keys(policy).some((key) => !["instructions", "minProbability", "criteria"].includes(key)))
				throw new Error("Unknown Jev policy field");
			if (typeof policy.instructions !== "string" || !policy.instructions.trim())
				throw new Error("Missing instructions");
			if (
				typeof policy.minProbability !== "number" ||
				!Number.isFinite(policy.minProbability) ||
				policy.minProbability < 0.5 ||
				policy.minProbability > 1
			) {
				throw new Error("minProbability must be between 0.5 and 1");
			}
			if (
				policy.criteria !== undefined &&
				(policy.criteria === null ||
					Array.isArray(policy.criteria) ||
					typeof policy.criteria !== "object" ||
					Object.values(policy.criteria).some((value) => typeof value !== "string"))
			) {
				throw new Error("criteria must be an object");
			}
		},
		async evaluate(request, policy, signal): Promise<DecisionResult> {
			if (signal.aborted) return { status: "failed", reason: "aborted" };
			if (!request.candidates.length || request.candidates.length > 255)
				return { status: "abstained", reason: "candidate_count" };
			const minimum = policy.minProbability;
			if (
				typeof minimum !== "number" ||
				!Number.isFinite(minimum) ||
				minimum < 0.5 ||
				minimum > 1 ||
				typeof policy.instructions !== "string"
			) {
				return { status: "failed", reason: "invalid_policy" };
			}
			const candidates = request.candidates.map((candidate, index) => ({ label: `c${index}`, ...candidate }));
			const state = {
				features: request.features,
				candidates,
				currentCandidateId: request.currentCandidateId ?? null,
			};
			let requests = 0;
			let providerEvidence: Json = null;
			try {
				if (subsetDefinitions.includes(request.definition) || request.definition === "context.retention/v1") {
					const criteria = policy.criteria;
					if (
						!criteria ||
						Array.isArray(criteria) ||
						typeof criteria !== "object" ||
						typeof criteria.true !== "string" ||
						typeof criteria.false !== "string"
					) {
						return { status: "failed", reason: "invalid_policy" };
					}
					const retentionCriteria = { true: criteria.true, false: criteria.false };
					const questions = Object.fromEntries(
						candidates.map(({ label }) => [
							label,
							noul({ instructions: policy.instructions, candidate: label }, retentionCriteria),
						]),
					);
					requests++;
					const response = await client.systemOne({ state, questions }, { signal, retry: { maxRetries: 0 } });
					providerEvidence = JSON.parse(JSON.stringify(response)) as Json;
					const usage = { requests, tokens: response.usage.input_tokens + response.usage.output_tokens };
					if (signal.aborted) return { status: "failed", reason: "aborted", usage, evidence: providerEvidence };
					const probabilities: Record<string, number> = {};
					const selected: string[] = [];
					for (const candidate of candidates) {
						const probability = response.answers[candidate.label]?.noul;
						if (!validProbability(probability))
							return {
								status: "failed",
								reason: "invalid_response",
								usage,
								evidence: providerEvidence,
								scores: probabilities,
							};
						probabilities[candidate.id] = probability;
						// Uncertainty retains context. Only a confident negative may discard it.
						if (probability > 1 - minimum) selected.push(candidate.id);
					}
					return {
						status: "proposed",
						answer:
							request.definition === "context.retention/v1"
								? { kind: "score", values: probabilities }
								: { kind: "subset", candidateIds: selected },
						evidence: { model: response.model, probabilities, scale: "probability", response: providerEvidence },
						scores: probabilities,
						usage,
					};
				}
				if (candidates.length === 1)
					return {
						status: "proposed",
						answer: { kind: "select", candidateId: candidates[0].id },
						usage: { requests: 0 },
						evidence: { scoreSource: "single_candidate" },
					};
				const policyCriteria =
					policy.criteria && typeof policy.criteria === "object" && !Array.isArray(policy.criteria)
						? policy.criteria
						: {};
				const criteria = Object.fromEntries(
					candidates.map(({ label, id, description }) => [
						label,
						typeof policyCriteria[id] === "string" ? policyCriteria[id] : description,
					]),
				);
				requests++;
				const response = await client.systemOne(
					{ state, questions: { selection: choice(policy.instructions, criteria) } },
					{ signal, retry: { maxRetries: 0 } },
				);
				const usage = { requests, tokens: response.usage.input_tokens + response.usage.output_tokens };
				providerEvidence = JSON.parse(JSON.stringify(response)) as Json;
				if (signal.aborted) return { status: "failed", reason: "aborted", usage, evidence: providerEvidence };
				const answer = response.answers.selection;
				const selected = candidates.find(({ label }) => label === answer.choice);
				if (
					!selected ||
					!validProbability(answer.confidence) ||
					candidates.some(({ label }) => !validProbability(answer.probabilities[label]))
				)
					return { status: "failed", reason: "invalid_response", usage, evidence: providerEvidence };
				const scores = Object.fromEntries(candidates.map(({ id, label }) => [id, answer.probabilities[label]]));
				const evidence = {
					model: response.model,
					response: providerEvidence,
					probability: answer.probabilities[selected.label],
					scale: "probability",
				};
				if (answer.probabilities[selected.label] < minimum)
					return { status: "abstained", reason: "low_probability", usage, scores, evidence };
				return {
					status: "proposed",
					answer: { kind: "select", candidateId: selected.id },
					evidence,
					scores,
					usage,
				};
			} catch (error) {
				return {
					status: "failed",
					usage: { requests },
					evidence: providerEvidence,
					reason: signal.aborted
						? "aborted"
						: error instanceof APITimeoutError
							? "timeout"
							: error instanceof APIError && error.status === 429
								? "rate_limit"
								: "provider_error",
				};
			}
		},
	};
}

function validProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
