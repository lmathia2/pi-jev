import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "./extensions/types.ts";

export interface GenerationRouteDecision {
	route: string;
	probability: number;
	fit: number;
	metadata?: unknown;
}

export type GenerationRouteProviderResult = { decision: GenerationRouteDecision } | { fallback: string };

export interface GenerationRouteProvider {
	decide(task: string, signal?: AbortSignal): Promise<GenerationRouteProviderResult>;
}

export interface GenerationRouteProfile {
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	tools?: readonly string[];
}

export interface GenerationRouteRecord {
	kind: "route";
	turn: number;
	decision?: GenerationRouteDecision;
	applied?: GenerationRouteProfile;
	fallback?: string;
}

export const defaultGenerationRouteProvider: GenerationRouteProvider = {
	async decide() {
		return { fallback: "disabled" };
	},
};

export function createGenerationRoutingExtension(options: {
	provider: GenerationRouteProvider;
	routes: Readonly<Record<string, GenerationRouteProfile>>;
	shadow?: boolean;
	onRecord?(record: GenerationRouteRecord): void;
}): InlineExtension {
	return {
		name: "generation-routing",
		hidden: true,
		factory(pi) {
			let turn = 0;
			const record = (value: GenerationRouteRecord) => {
				pi.appendEntry("generation-route", value);
				try {
					options.onRecord?.(value);
				} catch {
					// Routing telemetry must not affect execution.
				}
			};

			pi.on("before_agent_start", async (event, context) => {
				turn += 1;
				const currentTurn = turn;
				if (options.shadow) {
					void options.provider
						.decide(event.prompt, context.signal)
						.then((result) => {
							record(
								"decision" in result
									? { kind: "route", turn: currentTurn, decision: result.decision }
									: { kind: "route", turn: currentTurn, fallback: result.fallback },
							);
						})
						.catch(() => record({ kind: "route", turn: currentTurn, fallback: "provider_error" }));
					return;
				}

				let result: GenerationRouteProviderResult;
				try {
					result = await options.provider.decide(event.prompt, context.signal);
				} catch {
					record({ kind: "route", turn: currentTurn, fallback: "provider_error" });
					return;
				}
				if ("fallback" in result) {
					record({ kind: "route", turn: currentTurn, fallback: result.fallback });
					return;
				}
				const decision = result.decision;

				const profile = options.routes[decision.route];
				if (profile === undefined) {
					record({ kind: "route", turn: currentTurn, decision, fallback: "unknown_route" });
					return;
				}
				const model = profile.model
					? context.modelRegistry.find(profile.model.provider, profile.model.id)
					: undefined;
				if (profile.model && model === undefined) {
					record({ kind: "route", turn: currentTurn, decision, fallback: "model_unavailable" });
					return;
				}
				const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
				if (profile.tools?.some((tool) => !availableTools.has(tool))) {
					record({ kind: "route", turn: currentTurn, decision, fallback: "tool_unavailable" });
					return;
				}
				if (model && !(await pi.setModel(model))) {
					record({ kind: "route", turn: currentTurn, decision, fallback: "model_auth" });
					return;
				}
				if (profile.thinkingLevel) pi.setThinkingLevel(profile.thinkingLevel);
				if (profile.tools) pi.setActiveTools([...profile.tools]);
				record({ kind: "route", turn: currentTurn, decision, applied: profile });
			});
		},
	};
}
