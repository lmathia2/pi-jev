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
import { createContextRecallExtension } from "./context-recall.ts";
import { createDecisionRecallExtension } from "./decision-components.ts";
import { createConfiguredDecisionExtension } from "./decision-runtime.ts";

/** Called by the resource loader only after it has applied project trust and reloaded settings. */
export function createConfiguredJevExtensions(settings: JevSettings, cwd: string): InlineExtension[] {
	const routing = createConfiguredGenerationRoutingExtension(settings, { cwd });
	return [
		createDecisionRecallExtension(),
		createContextRecallExtension({ recoveryOnly: true }),
		...(routing ? [routing] : []),
	];
}

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
		cwd?: string;
		onRecord?(record: GenerationRouteRecord): void;
	} = {},
): InlineExtension | undefined {
	const apiKey = options.apiKey === undefined ? process.env.TYPESAFE_API_KEY?.trim() : options.apiKey.trim();
	const mode = settings.mode ?? "off";
	if (mode === "decisions")
		return createConfiguredDecisionExtension(settings.decisions ?? {}, {
			cwd: options.cwd,
			...(apiKey
				? {
						client: createJevClient({
							apiKey,
							baseURL: options.baseURL,
							fetch: options.fetch,
							timeoutMs: settings.timeoutMs ?? 5000,
						}),
					}
				: {}),
		});
	if (mode !== "route" || !apiKey) return undefined;
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
		onRecord: options.onRecord,
	});
}
