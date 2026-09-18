import type { AgentMessage, HookHandler, LaneConfiguration } from "@earendil-works/pi-agent-core";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { decideJevRoute } from "./client.ts";
import type { JevRouteId } from "./types.ts";

export interface JevGenerationRouterOptions {
	client: TypeSafeClient;
	routes: Record<JevRouteId, Partial<LaneConfiguration>>;
	minProbability?: number;
	minFit?: number;
	timeoutMs?: number;
	requiredToolNames?: readonly string[];
}

export function createJevGenerationRouter(options: JevGenerationRouterOptions): HookHandler<"before_generation"> {
	return async (event, context) => {
		const task = latestUserText(event.messages);
		if (task === undefined) return undefined;
		const result = await decideJevRoute(options.client, task, {
			signal: context.abortSignal,
			timeoutMs: options.timeoutMs ?? 5_000,
		});
		if (
			!result.ok ||
			result.decision.probabilities[result.decision.route] < (options.minProbability ?? 0.7) ||
			result.decision.fit < (options.minFit ?? 0.7)
		) {
			return undefined;
		}
		const configuration = options.routes[result.decision.route];
		if (configuration.activeToolNames === undefined || options.requiredToolNames === undefined) {
			return { configuration };
		}
		return {
			configuration: {
				...configuration,
				activeToolNames: [...new Set([...configuration.activeToolNames, ...options.requiredToolNames])],
			},
		};
	};
}

function latestUserText(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return text || undefined;
	}
	return undefined;
}
