import type { Fetch } from "@typesafe-ai/sdk";
import type { InlineExtension } from "../core/extensions/types.ts";
import {
	createGenerationRoutingExtension,
	type GenerationRouteProfile,
	type GenerationRouteProvider,
	type GenerationRouteRecord,
} from "../core/generation-routing.ts";
import type { JevSettings } from "../core/settings-manager.ts";
import { createJevClient, decideJevRoute } from "./client.ts";

export function createJevGenerationRouteProvider(options: {
	apiKey: string;
	baseURL?: string;
	fetch?: Fetch;
	timeoutMs?: number;
	minProbability?: number;
	minFit?: number;
}): GenerationRouteProvider {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const client = createJevClient({
		apiKey: options.apiKey,
		baseURL: options.baseURL,
		fetch: options.fetch,
		timeoutMs,
	});
	return {
		async decide(task, signal) {
			const result = await decideJevRoute(client, task, { signal, timeoutMs });
			if (!result.ok) return { fallback: result.failure };
			const probability = result.decision.probabilities[result.decision.route];
			if (probability < (options.minProbability ?? 0.7)) return { fallback: "low_probability" };
			if (result.decision.fit < (options.minFit ?? 0.7)) return { fallback: "low_fit" };
			return {
				decision: {
					route: result.decision.route,
					probability,
					fit: result.decision.fit,
					metadata: {
						model: result.decision.model,
						usage: result.decision.usage,
						durationMs: result.durationMs,
					},
				},
			};
		},
	};
}

export function createConfiguredGenerationRoutingExtension(
	settings: JevSettings,
	options: {
		apiKey?: string;
		baseURL?: string;
		fetch?: Fetch;
		onRecord?(record: GenerationRouteRecord): void;
	} = {},
): InlineExtension | undefined {
	const apiKey = options.apiKey === undefined ? process.env.TYPESAFE_API_KEY?.trim() : options.apiKey.trim();
	const mode = settings.mode ?? "off";
	if ((mode !== "shadow" && mode !== "route") || !apiKey) return undefined;
	const provider = createJevGenerationRouteProvider({
		apiKey,
		baseURL: options.baseURL,
		fetch: options.fetch,
		timeoutMs: settings.timeoutMs,
		minProbability: settings.minProbability,
		minFit: settings.minFit,
	});
	const routes: Record<string, GenerationRouteProfile> = {};
	for (const [id, route] of Object.entries(settings.routes ?? {})) {
		routes[id] = {
			...(route.provider && route.model ? { model: { provider: route.provider, id: route.model } } : {}),
			...(route.thinkingLevel ? { thinkingLevel: route.thinkingLevel } : {}),
			...(route.tools ? { tools: route.tools } : {}),
		};
	}
	return createGenerationRoutingExtension({
		provider,
		routes,
		shadow: mode !== "route",
		onRecord: options.onRecord,
	});
}
