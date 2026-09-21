import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { DecisionRequest, DecisionResult } from "@earendil-works/pi-decisions";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createFindTool } from "../../src/core/tools/find.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import {
	createDecisionComponentsExtension,
	createDecisionRecallExtension,
	type DecisionComponentRecord,
	selectDecisionContext,
} from "../../src/jev/decision-components.ts";
import { createConfiguredDecisionExtension } from "../../src/jev/decision-runtime.ts";
import {
	createDecisionSkillSelector,
	selectDecisionSkills,
	selectRetrievedContext,
} from "../../src/jev/decision-selection.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const output = Array.from({ length: 80 }, (_, i) => `ordinary record ${i} ${"x".repeat(80)}\n`).join("");
const tool: AgentTool = {
	name: "logs",
	label: "logs",
	description: "logs",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
};
const outputConfig = { tools: ["logs"], minChars: 100, maxChars: 20000, blockLines: 5, minReduction: 0.2 };
const dropOptional = async (): Promise<DecisionResult> => ({
	status: "proposed",
	answer: { kind: "subset", candidateIds: [] },
});

describe("decision components", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	it("stores original before trimming and recalls exact text through the model tool", async () => {
		const records: DecisionComponentRecord[] = [];
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				createDecisionComponentsExtension({
					evaluate: dropOptional,
					output: outputConfig,
					onRecord(record) {
						records.push(record);
						throw new Error("diagnostic failure");
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("logs", {}, { id: "log-call" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("recall_output", { id: "log-call" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect activity");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(results[0])).toContain("Output reduced");
		expect(getMessageText(results[0]).length).toBeLessThan(output.length / 2);
		expect(getMessageText(results[1])).toBe(output);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			definition: "output.select/v1",
			boundaryId: "log-call",
			outcome: "proposed",
			effectiveAction: "trim",
		});
		expect(JSON.stringify(records)).not.toContain("ordinary record");
		expect(JSON.stringify(records)).not.toContain("inspect activity");
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "decision-component/v1"),
		).toHaveLength(1);
		const branch = harness.sessionManager.getBranch();
		const storedIndex = branch.findIndex(
			(entry) => entry.type === "custom" && entry.customType === "decision-original-output/v1",
		);
		const resultIndex = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(storedIndex).toBeGreaterThan(-1);
		expect(storedIndex).toBeLessThan(resultIndex);
		await harness.session.reload();
		const reloadedProvider = registerFauxProvider({ api: harness.faux.api, provider: harness.getModel().provider });
		reloadedProvider.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_output", { id: "log-call", startLine: 2, endLine: 3 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("recalled"),
		]);
		await harness.session.prompt("recall earlier activity");
		const recalled = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
		expect(getMessageText(recalled)).toBe(`${output.split("\n").slice(1, 3).join("\n")}\n`);
		const beforeOriginal = branch[storedIndex - 1];
		harness.sessionManager.branch(beforeOriginal.id);
		reloadedProvider.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_output", { id: "log-call" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("unavailable"),
		]);
		await harness.session.prompt("recall from another branch");
		expect(
			getMessageText(harness.session.messages.filter((message) => message.role === "toolResult").at(-1)),
		).toContain("No original output");
	});
	it("completion verification admits only the configured number of follow-ups", async () => {
		let decisions = 0;
		const harness = await createHarness({
			extensionFactories: [
				createDecisionComponentsExtension({
					evaluate: async () => {
						decisions++;
						return { status: "proposed", answer: { kind: "select", candidateId: "verify" } };
					},
					completion: { maxPasses: 1 },
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("claimed done"), fauxAssistantMessage("verified done")]);
		await harness.session.prompt("finish the task");
		await harness.session.waitForIdle();
		expect(decisions).toBe(1);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "decision-completion-pass/v1"),
		).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
	it("parallel output decisions are not invalidated by sibling audit records", async () => {
		let arrived = 0;
		let release = () => {};
		const both = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				createDecisionComponentsExtension({
					output: outputConfig,
					evaluate: async () => {
						if (++arrived === 2) release();
						await both;
						return dropOptional();
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("logs", {}), fauxToolCall("logs", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect activity");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		for (const result of results) expect(getMessageText(result)).toContain("Output reduced");
	});
	it("successful retries clear prior completion failures", async () => {
		let calls = 0;
		const harness = await createHarness({
			tools: [
				{
					...tool,
					execute: async () => {
						if (++calls === 1) throw new Error("failed check");
						return { content: [{ type: "text", text: "passed" }], details: {} };
					},
				},
			],
			extensionFactories: [
				createDecisionComponentsExtension({
					completion: { maxPasses: 1 },
					evaluate: async () => ({ status: "proposed", answer: { kind: "select", candidateId: "accept" } }),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("logs", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("logs", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("check work");
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "decision-completion-pass/v1"),
		).toBe(false);
	});
	it("recall-only startup adds no tool until saved output exists", async () => {
		const harness = await createHarness({ extensionFactories: [createDecisionRecallExtension()] });
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).not.toContain("recall_output");
		harness.sessionManager.appendCustomEntry("decision-original-output/v1", { id: "old", text: "saved\ntext\n" });
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_output", { id: "old" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("retrieve saved output");
		expect(getMessageText(harness.session.messages.find((message) => message.role === "toolResult"))).toBe(
			"saved\ntext\n",
		);
	});
	it("ranks actual find output and retains exact recall", async () => {
		const paths = Array.from({ length: 12 }, (_, index) => `src/${index}-${"x".repeat(150)}.ts`);
		const harness = await createHarness({
			tools: [createFindTool(".", { operations: { exists: () => true, glob: async () => paths } })],
			extensionFactories: [
				createDecisionComponentsExtension({
					retrieval: { minChars: 100, maxChars: 20000, minReduction: 0.2 },
					evaluate: async (request) => {
						expect(request.definition).toBe("retrieval.rank/v1");
						return dropOptional();
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find", { pattern: "*.ts" }, { id: "find-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("recall_output", { id: "find-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect repository");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(results[0])).toContain("Output reduced");
		expect(getMessageText(results[1])).toBe(paths.join("\n"));
	});
	it("skill visibility selects from the full roster on later phases before prompt rendering", async () => {
		const skills = ["one", "two"].map((name) => ({
			name,
			description: name,
			filePath: `/skills/${name}/SKILL.md`,
			baseDir: `/skills/${name}`,
			sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
			disableModelInvocation: false,
		}));
		let phase = "one";
		const seen: string[][] = [];
		const select = createDecisionSkillSelector({
			evaluate: async (request) => ({
				status: "proposed",
				answer: { kind: "subset", candidateIds: [String(request.features.phase)] },
			}),
		});
		const harness = await createHarness({
			tools: [
				{
					...tool,
					execute: async () => {
						phase = "two";
						return { content: [], details: {} };
					},
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = skills;
					});
					pi.on("before_generation", async (event, context) => {
						await select(event, context, phase, pi, "inspect activity");
						seen.push(event.systemPromptOptions.skills.map((skill) => skill.name));
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("logs", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect activity");
		expect(seen).toEqual([["one"], ["two"]]);
	});
	it("configured bundles select skills before routing and rank built-in search output", async () => {
		const calls: string[] = [];
		const paths = Array.from({ length: 12 }, (_, index) => `src/${index}-${"x".repeat(150)}.ts`);
		const skills = ["wanted", "unneeded"].map((name) => ({
			name,
			description: name,
			filePath: `/skills/${name}/SKILL.md`,
			baseDir: `/skills/${name}`,
			sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
			disableModelInvocation: false,
		}));
		const binding = { implementation: "fixture", policy: {} };
		const errors: unknown[] = [];
		const configured = createConfiguredDecisionExtension(
			{
				bindings: { "skills.select/v1": binding, "retrieval.rank/v1": binding },
				components: { skills: true, retrieval: { minChars: 100, maxChars: 20000, minReduction: 0.2 } },
				routing: {
					binding,
					phases: ["investigate"],
					routes: [
						{
							id: "configured",
							description: "configured",
							provider: "faux",
							model: "faux-1",
							effort: "off",
							tools: ["find", "recall_output"],
						},
					],
					requiredTools: ["recall_output"],
					timeoutMs: 1000,
					maxDecisions: 10,
					estimate: { requests: 1, outputTokens: 100, marginUsd: 0, decisionCostUsd: 0 },
				},
			},
			{
				onError(error) {
					errors.push(error);
				},
				implementations: [
					{
						id: "fixture",
						version: "1",
						definitions: ["generation.route/v1", "skills.select/v1", "retrieval.rank/v1"],
						async evaluate(request) {
							calls.push(request.definition);
							return request.definition === "generation.route/v1"
								? { status: "proposed", answer: { kind: "select", candidateId: "keep_current" } }
								: {
										status: "proposed",
										usage: { requests: 1, tokens: 17, costUsd: 0.0001 },
										answer: {
											kind: "subset",
											candidateIds: request.definition === "skills.select/v1" ? ["wanted"] : [],
										},
									};
						},
					},
				],
			},
		);
		const harness = await createHarness({
			tools: [
				createReadTool("."),
				createFindTool(".", { operations: { exists: () => true, glob: async () => paths } }),
			],
			extensionFactories: [
				configured,
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.skills = skills;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				const prompt = getCurrentSystemPrompt(context.messages);
				expect(prompt).toContain("/skills/wanted/SKILL.md");
				expect(prompt).not.toContain("/skills/unneeded/SKILL.md");
				return fauxAssistantMessage([fauxToolCall("find", { pattern: "*.ts" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect repository");
		expect(errors).toEqual([]);
		expect(
			harness.session.messages
				.filter((message) => message.role === "assistant")
				.map((message) => message.errorMessage)
				.filter(Boolean),
		).toEqual([]);
		expect(calls).toEqual(["skills.select/v1", "generation.route/v1", "retrieval.rank/v1"]);
		for (const type of ["decision-skills", "decision-component/v1"]) {
			const entry = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "custom" && entry.customType === type);
			expect(entry).toMatchObject({
				data: {
					invocation: {
						implementationId: "fixture",
						implementationVersion: "1",
						policyDigest: expect.any(String),
						inputDigest: expect.any(String),
						elapsedMs: expect.any(Number),
						costUsd: 0.0001,
						tokenCount: 17,
						requestCount: 1,
					},
				},
			});
		}
		expect(getMessageText(harness.session.messages.find((message) => message.role === "toolResult"))).toContain(
			"Output reduced",
		);
	});
	it("full-output requests and failed decisions preserve original", async () => {
		let calls = 0;
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				createDecisionComponentsExtension({
					evaluate: async () => {
						calls++;
						throw new Error("offline");
					},
					output: outputConfig,
				}),
			],
		});
		harnesses.push(harness);
		for (const prompt of ["show full output", "inspect activity"]) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("logs", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt(prompt);
		}
		expect(calls).toBe(1);
		for (const result of harness.session.messages.filter((message) => message.role === "toolResult"))
			expect(getMessageText(result)).toBe(output);
	});
	it("tool review fail-closed prevents execution", async () => {
		let calls = 0;
		const harness = await createHarness({
			tools: [
				{
					...tool,
					execute: async () => {
						calls++;
						return { content: [], details: {} };
					},
				},
			],
			extensionFactories: [
				createDecisionComponentsExtension({
					evaluate: async () => ({ status: "failed", reason: "timeout" }),
					review: { tools: ["logs"], onFailure: "block" },
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("logs", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked"),
		]);
		await harness.session.prompt("inspect activity");
		expect(calls).toBe(0);
	});
	it("retains required groups and rejects unknown selection IDs", async () => {
		const request: DecisionRequest = {
			definition: "retrieval.rank/v1",
			boundaryId: "1",
			stateRevision: "1",
			features: {},
			candidates: [
				{ id: "a", description: "a", attributes: { required: true, group: "pair" } },
				{ id: "b", description: "b", attributes: { group: "pair" } },
				{ id: "c", description: "c", attributes: {} },
			],
		};
		expect(await selectDecisionContext(request, dropOptional)).toEqual(["a", "b"]);
		expect(
			await selectDecisionContext(request, async () => ({
				status: "proposed",
				answer: { kind: "subset", candidateIds: ["unknown"] },
			})),
		).toEqual(["a", "b", "c"]);
	});
	it("retrieval preserves dependent groups and fails unchanged when the selection exceeds budget", async () => {
		const candidates = [
			{
				id: "a",
				source: "file" as const,
				label: "a",
				excerpt: "required",
				required: true,
				group: "pair",
				tokens: 5,
			},
			{
				id: "b",
				source: "file" as const,
				label: "b",
				excerpt: "dependency",
				required: false,
				group: "pair",
				tokens: 5,
			},
			{ id: "c", source: "file" as const, label: "c", excerpt: "optional", required: false, tokens: 5 },
		];
		const snapshot = { boundaryId: "b", stateRevision: "1", features: {} };
		expect(
			(await selectRetrievedContext(candidates, 10, snapshot, dropOptional)).map((candidate) => candidate.id),
		).toEqual(["a", "b"]);
		expect(await selectRetrievedContext(candidates, 5, snapshot, dropOptional)).toBe(candidates);
		const skills = ["explicit", "optional", "manual"].map((name) => ({
			name,
			description: name,
			filePath: `/skills/${name}/SKILL.md`,
			baseDir: `/skills/${name}`,
			sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
			disableModelInvocation: name === "manual",
		}));
		expect(
			(await selectDecisionSkills(skills, ["explicit", "manual"], snapshot, dropOptional)).map(
				(skill) => skill.name,
			),
		).toEqual(["explicit", "manual"]);
	});
});
