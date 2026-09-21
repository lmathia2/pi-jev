export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Candidate {
	id: string;
	description: string;
	attributes: Readonly<Record<string, Json>>;
}

export interface DecisionRequest {
	definition: string;
	boundaryId: string;
	stateRevision: string;
	features: Readonly<Record<string, Json>>;
	candidates: readonly Candidate[];
	currentCandidateId?: string;
}

export type DecisionAnswer =
	| { kind: "select"; candidateId: string }
	| { kind: "subset"; candidateIds: readonly string[] }
	| { kind: "score"; values: Readonly<Record<string, number>> };

export interface DecisionUsage {
	requests: number;
	costUsd?: number;
	tokens?: number;
}

export type DecisionResult = (
	| { status: "proposed"; answer: DecisionAnswer; evidence?: Json }
	| { status: "abstained"; reason: string }
	| { status: "failed"; reason: string }
) & { usage?: DecisionUsage };

export interface DecisionImplementation {
	id: string;
	version: string;
	definitions: readonly string[];
	validatePolicy?(policy: Readonly<Record<string, Json>>): void;
	evaluate(
		request: DecisionRequest,
		policy: Readonly<Record<string, Json>>,
		signal: AbortSignal,
	): Promise<DecisionResult>;
}

export interface DecisionDefinition {
	id: string;
	answerKind: DecisionAnswer["kind"];
	validate?(request: DecisionRequest, answer: DecisionAnswer): boolean;
}

export interface DecisionInvocation {
	result: DecisionResult;
	implementationId: string;
	implementationVersion: string;
	inputDigest: string;
	policyDigest: string;
	elapsedMs: number;
	requestCount: number;
	tokenCount: number | null;
	costUsd: number | null;
}
