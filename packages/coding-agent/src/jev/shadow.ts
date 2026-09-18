import type { InlineExtension } from "../core/extensions/types.ts";
import { createJevClient, decideJevRoute } from "./client.ts";
import { JEV_ROUTE_IDS, type JevShadowOptions } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

export function createJevShadowExtension(options: JevShadowOptions): InlineExtension {
	return {
		name: "jev-shadow",
		hidden: true,
		factory(pi) {
			const apiKey = options.apiKey === undefined ? process.env.TYPESAFE_API_KEY?.trim() : options.apiKey.trim();
			if (!apiKey) return;

			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const client = createJevClient({
				apiKey,
				baseURL: options.baseURL,
				fetch: options.fetch,
				timeoutMs,
			});
			let turn = 0;
			let modelCalls = 0;
			let toolCalls = 0;
			let compactions = 0;
			const record = (value: Parameters<JevShadowOptions["onRecord"]>[0]) => {
				try {
					options.onRecord(value);
				} catch {
					// Shadow telemetry must not affect agent execution.
				}
			};

			pi.on("before_agent_start", (event, context) => {
				turn += 1;
				const currentTurn = turn;
				modelCalls = 0;
				toolCalls = 0;
				compactions = 0;
				void decideJevRoute(client, event.prompt, {
					signal: context.signal,
					timeoutMs,
				}).then((result) => record({ kind: "route", turn: currentTurn, candidateIds: JEV_ROUTE_IDS, result }));
			});

			pi.on("turn_start", () => {
				modelCalls += 1;
			});
			pi.on("tool_execution_start", () => {
				toolCalls += 1;
			});
			pi.on("session_compact", () => {
				compactions += 1;
			});
			pi.on("agent_settled", () => {
				record({ kind: "outcome", turn, modelCalls, toolCalls, compactions });
			});
		},
	};
}
