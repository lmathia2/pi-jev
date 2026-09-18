import type { Fetch, Usage } from "@typesafe-ai/sdk";

export const JEV_ROUTE_IDS = ["fast", "standard", "deep", "research"] as const;
export type JevRouteId = (typeof JEV_ROUTE_IDS)[number];

export type JevFailure = "aborted" | "invalid_response" | "rate_limit" | "service" | "timeout" | "unavailable";

export interface JevRouteDecision {
	route: JevRouteId;
	confidence: number;
	fit: number;
	probabilities: Record<JevRouteId, number>;
	model: string;
	usage: Usage;
}

export type JevRouteResult =
	| { ok: true; decision: JevRouteDecision; durationMs: number }
	| { ok: false; failure: JevFailure; durationMs: number };

export interface JevCandidate {
	id: string;
	description: string;
}

export type JevSelectionResult =
	| { ok: true; id: string; confidence: number; fit: number }
	| { ok: false; failure: JevFailure | "no_candidates" | "rejected" };

export interface ContextCandidate {
	id: string;
	source: "message" | "file" | "symbol" | "git" | "document";
	label: string;
	excerpt: string;
	required: boolean;
}

export type JevFindResult =
	| { ok: true; relevance: Readonly<Record<string, number>>; fit: number }
	| { ok: false; failure: JevFailure | "no_candidates" };

export interface JevShadowOptions {
	apiKey?: string;
	baseURL?: string;
	fetch?: Fetch;
	timeoutMs?: number;
	onRecord(record: JevShadowRecord): void;
}

export type JevShadowRecord =
	| {
			kind: "route";
			turn: number;
			candidateIds: readonly JevRouteId[];
			result: JevRouteResult;
	  }
	| {
			kind: "outcome";
			turn: number;
			modelCalls: number;
			toolCalls: number;
			compactions: number;
	  };
