import { resolve } from "node:path";
import {
	type DecisionImplementation,
	DecisionRegistry,
	digestJson,
	heuristicImplementation,
	keepCurrentImplementation,
	loadPolicyPackage,
	PolicyStore,
} from "@earendil-works/pi-decisions";
import { createJevImplementation } from "@earendil-works/pi-decisions/jev";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { InlineExtension } from "../core/extensions/types.ts";
import { createContextRecallExtension } from "./context-recall.ts";
import { createDecisionComponentsExtension, type DecisionComponentsOptions } from "./decision-components.ts";
import {
	type ContextManagementSettings,
	contextRequirements,
	createDecisionContextExtension,
} from "./decision-context.ts";
import {
	createDecisionRoutingExtension,
	type DecisionBinding,
	type DecisionRoutingSettings,
} from "./decision-routing.ts";
import { createDecisionSkillSelector } from "./decision-selection.ts";
import { createDecisionWorkflowsExtension, type DecisionWorkflowSettings } from "./decision-workflows.ts";

export interface DecisionSettings {
	policyPackages?: string[];
	/** Optional reviewed SHA-256 artifact pins, keyed by id@version, enforced across restarts. */
	policyDigests?: Record<string, string>;
	/** Immutable policy references, e.g. team/routing@1, override inline bindings. */
	policyReferences?: Record<string, string>;
	bindings?: Record<string, DecisionBinding>;
	routing?: DecisionRoutingSettings;
	components?: Pick<DecisionComponentsOptions, "output" | "retrieval" | "review" | "completion"> &
		DecisionWorkflowSettings & {
			skills?: boolean;
			context?: ContextManagementSettings;
		};
	timeoutMs?: number;
	maxComponentDecisions?: number;
}

/** Invalid initial configuration disables decisions; it never partially enables a bundle. */
export function createConfiguredDecisionExtension(
	settings: DecisionSettings,
	options: {
		client?: TypeSafeClient;
		cwd?: string;
		implementations?: DecisionImplementation[];
		onError?(error: unknown): void;
	} = {},
): InlineExtension {
	try {
		digestJson(settings);
		if (
			Object.keys(settings).some(
				(key) =>
					![
						"policyPackages",
						"policyDigests",
						"policyReferences",
						"bindings",
						"routing",
						"components",
						"timeoutMs",
						"maxComponentDecisions",
					].includes(key),
			)
		)
			throw new Error("Unknown decision configuration field");
		if (
			settings.policyPackages &&
			(!Array.isArray(settings.policyPackages) ||
				settings.policyPackages.some((path) => typeof path !== "string" || !path))
		)
			throw new Error("Invalid policy package paths");
		const registry = new DecisionRegistry();
		registry.register(keepCurrentImplementation);
		registry.register(heuristicImplementation);
		if (options.client) registry.register(createJevImplementation(options.client));
		for (const implementation of options.implementations ?? []) registry.register(implementation);
		const policies = new PolicyStore(
			(artifact) => registry.validatePolicy(artifact.implementation, artifact.definition, artifact.policy),
			settings.policyDigests,
		);
		policies.activate(
			(settings.policyPackages ?? []).flatMap((path) =>
				loadPolicyPackage(resolve(options.cwd ?? process.cwd(), path)),
			),
		);
		const bindings = structuredClone(settings.bindings ?? {});
		for (const [definition, reference] of Object.entries(settings.policyReferences ?? {})) {
			const resolved = policies.get(reference);
			if (!resolved || resolved.artifact.definition !== definition || resolved.artifact.projectionVersion !== "1")
				throw new Error(`Invalid policy reference: ${reference}`);
			bindings[definition] = { implementation: resolved.artifact.implementation, policy: resolved.artifact.policy };
		}
		const routing = settings.routing ? structuredClone(settings.routing) : undefined;
		if (
			settings.components &&
			Object.keys(settings.components).some(
				(key) =>
					![
						"output",
						"retrieval",
						"review",
						"completion",
						"skills",
						"context",
						"recovery",
						"evidence",
						"specialists",
					].includes(key),
			)
		)
			throw new Error("Unknown decision component");
		if (settings.components?.skills !== undefined && typeof settings.components.skills !== "boolean")
			throw new Error("Invalid skills enablement");
		if (settings.components?.skills && !routing) throw new Error("Skill selection requires phase routing");
		if (routing) {
			if (
				settings.components?.context &&
				(!routing.requiredTools.includes("recall_context") ||
					routing.routes.some((route) => !route.tools.includes("recall_context")))
			)
				throw new Error("Context management requires recall_context in every routing preset and requiredTools");
			if (
				(settings.components?.output || settings.components?.retrieval) &&
				(!routing.requiredTools.includes("recall_output") ||
					routing.routes.some((route) => !route.tools.includes("recall_output")))
			)
				throw new Error(
					"Output/retrieval selection requires recall_output in every routing preset and requiredTools",
				);
			routing.binding = bindings["generation.route/v1"] ?? routing.binding;
			if (bindings["generation.phase/v1"]) routing.phaseBinding = bindings["generation.phase/v1"];
			registry.validatePolicy(routing.binding.implementation, "generation.route/v1", routing.binding.policy);
			if (routing.phaseBinding)
				registry.validatePolicy(
					routing.phaseBinding.implementation,
					"generation.phase/v1",
					routing.phaseBinding.policy,
				);
		}
		for (const [definition, binding] of Object.entries(bindings))
			registry.validatePolicy(binding.implementation, definition, binding.policy);
		for (const [component, definition] of [
			["output", "output.select/v1"],
			["retrieval", "retrieval.rank/v1"],
			["skills", "skills.select/v1"],
			["review", "tools.review/v1"],
			["completion", "completion.verify/v1"],
			["context", "context.retention/v1"],
			["recovery", "recovery.action/v1"],
			["evidence", "evidence.verify/v1"],
			["specialists", "specialist.select/v1"],
		] as const) {
			if (settings.components?.[component] && !bindings[definition])
				throw new Error(`Missing enabled component binding: ${definition}`);
		}
		const timeoutMs = settings.timeoutMs ?? 5000;
		const maxDecisions = settings.maxComponentDecisions ?? 100;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxDecisions) || maxDecisions < 0)
			throw new Error("Invalid component limits");
		const budget = { remaining: maxDecisions };
		const evaluate: DecisionComponentsOptions["evaluate"] = async (request, signal) => {
			const binding = bindings[request.definition];
			if (!binding) return { status: "abstained", reason: "disabled" };
			const { result, ...invocation } = await registry.invoke(binding.implementation, request, binding.policy, {
				signal,
				timeoutMs,
				budget,
			});
			return { ...result, invocation };
		};
		const extensions: InlineExtension[] = [];
		if (settings.components?.recovery || settings.components?.evidence || settings.components?.specialists)
			extensions.push(createDecisionWorkflowsExtension(settings.components, evaluate));
		if (settings.components?.context) {
			extensions.push(createContextRecallExtension({ maxChars: settings.components.context.recallMaxChars }));
			extensions.push(
				createDecisionContextExtension({
					settings: settings.components.context,
					registry,
					binding: bindings["context.retention/v1"],
					timeoutMs,
					budget,
				}),
			);
		}
		if (routing)
			extensions.push(
				createDecisionRoutingExtension({
					registry,
					settings: routing,
					...(settings.components?.context
						? { contextRequirements: (context) => contextRequirements(context, settings.components!.context!) }
						: {}),
					...(settings.components?.skills ? { preparePhase: createDecisionSkillSelector({ evaluate }) } : {}),
				}),
			);
		if (settings.components)
			extensions.push(
				createDecisionComponentsExtension({
					...settings.components,
					evaluate,
				}),
			);
		return {
			name: "configured-decisions",
			hidden: true,
			async factory(pi) {
				for (const extension of extensions)
					await (typeof extension === "function" ? extension : extension.factory)(pi);
			},
		};
	} catch (error) {
		try {
			options.onError?.(error);
		} catch {
			/* Diagnostic callbacks are isolated. */
		}
		return {
			name: "invalid-decisions",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, context) => {
					context.ui.notify(
						`Decision configuration disabled: ${error instanceof Error ? error.message : "invalid settings"}`,
						"warning",
					);
				});
			},
		};
	}
}
