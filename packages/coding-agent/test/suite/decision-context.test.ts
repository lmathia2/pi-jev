import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import type { DecisionRequest } from "@earendil-works/pi-decisions";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { validateContextManagementSettings } from "../../src/jev/decision-context.ts";
import { createConfiguredDecisionExtension } from "../../src/jev/decision-runtime.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("configured context management", () => {
	it("rejects unknown settings and contradictory limits", () => {
		expect(() => validateContextManagementSettings(JSON.parse('{"__proto__": 1}'))).toThrow();
		expect(() => validateContextManagementSettings({ targetRatio: 0.95, triggerRatio: 0.9 })).toThrow();
		expect(() => validateContextManagementSettings({ concurrency: 3, maxRequests: 2 })).toThrow();
		expect(() => validateContextManagementSettings({ keepThreshold: 0 })).not.toThrow();
	});
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	it.each([true, false])("omits pairs and restores originals with cacheAware=%s", async (cacheAware) => {
		const large = "discarded record ".repeat(3000);
		const important = "relevant later ".repeat(300);
		const seen: Message[][] = [];
		const requests: DecisionRequest[] = [];
		const parameters = Type.Object({ name: Type.String() });
		const tool: AgentTool<typeof parameters> = {
			name: "logs",
			label: "logs",
			description: "logs",
			parameters,
			execute: async (_id, input) => ({
				content: [{ type: "text", text: input.name === "large" ? large : important }],
				details: {},
			}),
		};
		const errors: unknown[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 16000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			tools: [tool],
			extensionFactories: [
				createConfiguredDecisionExtension(
					{
						bindings: { "context.retention/v1": { implementation: "fixture", policy: {} } },
						components: {
							context: {
								safetyMarginTokens: 0,
								preserveRecentMessages: 0,
								...(cacheAware ? {} : { cacheAware }),
							},
						},
					},
					{
						onError: (error) => errors.push(error),
						implementations: [
							{
								id: "fixture",
								version: "1",
								definitions: ["context.retention/v1"],
								async evaluate(request) {
									requests.push(request);
									return {
										status: "proposed",
										answer: {
											kind: "score",
											values: Object.fromEntries(
												request.candidates.map((candidate) => [
													candidate.id,
													String(request.features.task).includes("restore") &&
													candidate.id.startsWith("important:")
														? 1
														: 0,
												]),
											),
										},
									};
								},
							},
						],
					},
				),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("logs", { name: "large" }, { id: "large" }),
					fauxToolCall("logs", { name: "important" }, { id: "important" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				seen.push(structuredClone(context.messages));
				return fauxAssistantMessage([fauxToolCall("recall_context", { toolCallId: "important", maxChars: 10 })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				seen.push(structuredClone(context.messages));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("inspect activity");
		expect(
			harness.session.messages
				.filter((message) => message.role === "assistant")
				.map((message) => message.errorMessage)
				.filter(Boolean),
		).toEqual([]);
		expect(errors).toEqual([]);
		expect(requests).toHaveLength(cacheAware ? 1 : 2);
		expect(seen).toHaveLength(2);
		for (const messages of seen) {
			expect(
				messages.some(
					(message) => message.role === "toolResult" && ["large", "important"].includes(message.toolCallId),
				),
			).toBe(false);
			expect(
				messages
					.flatMap((message) => (message.role === "assistant" ? message.content : []))
					.some((part) => part.type === "toolCall" && ["large", "important"].includes(part.id)),
			).toBe(false);
		}
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message) === important,
			),
		).toBe(true);
		harness.setResponses([
			(context) => {
				seen.push(structuredClone(context.messages));
				return fauxAssistantMessage("restored");
			},
		]);
		await harness.session.prompt("restore important activity");
		expect(requests).toHaveLength(cacheAware ? 2 : 3);
		expect(
			seen
				.at(-1)
				?.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === "important" &&
						getMessageText(message) === important,
				),
		).toBe(true);
	});
	it.each([false, true])(
		"preserves costly cached prefixes unless hardCapacity=%s requires pruning",
		async (hardCapacity) => {
			const parameters = Type.Object({ name: Type.String() });
			const tool: AgentTool<typeof parameters> = {
				name: "logs",
				label: "logs",
				description: "logs",
				parameters,
				execute: async (_id, input) => ({
					content: [
						{
							type: "text",
							text: "x".repeat(
								input.name === "early"
									? 3000
									: input.name === "retained"
										? 27000
										: input.name === "new" && !hardCapacity
											? 12000
											: 30000,
							),
						},
					],
					details: {},
				}),
			};
			let decisions = 0;
			const seen: Message[][] = [];
			const harness = await createHarness({
				models: [
					{
						id: "faux-1",
						contextWindow: 16000,
						maxTokens: 100,
						cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1000 },
					},
				],
				settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
				tools: [tool],
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", (event) => {
							// Faux replaces supplied usage with its own estimate; supply a deterministic observed cache fixture.
							const last = event.message;
							if (
								last?.role === "assistant" &&
								last.content.some((part) => part.type === "toolCall" && part.id === "new")
							)
								last.usage = { ...last.usage, cacheRead: 10000, totalTokens: 10000 };
						});
					},
					createConfiguredDecisionExtension(
						{
							bindings: { "context.retention/v1": { implementation: "fixture", policy: {} } },
							components: { context: { safetyMarginTokens: 0, preserveRecentMessages: 0 } },
						},
						{
							implementations: [
								{
									id: "fixture",
									version: "1",
									definitions: ["context.retention/v1"],
									async evaluate(request) {
										decisions++;
										return {
											status: "proposed",
											answer: {
												kind: "score",
												values: Object.fromEntries(
													request.candidates.map((candidate) => [
														candidate.id,
														decisions === 1
															? candidate.id.startsWith("discard:")
																? 0
																: 1
															: !hardCapacity &&
																	!candidate.id.startsWith("early:") &&
																	!candidate.id.startsWith("discard:")
																? 1
																: 0,
													]),
												),
											},
										};
									},
								},
							],
						},
					),
				],
			});
			harnesses.push(harness);
			const cached = fauxAssistantMessage([fauxToolCall("logs", { name: "new" }, { id: "new" })], {
				stopReason: "toolUse",
			});
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("logs", { name: "discard" }, { id: "discard" }),
						fauxToolCall("logs", { name: "early" }, { id: "early" }),
						fauxToolCall("logs", { name: "retained" }, { id: "retained" }),
					],
					{ stopReason: "toolUse" },
				),
				cached,
				(context) => {
					seen.push(structuredClone(context.messages));
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("inspect logs");
			expect(
				harness.session.messages
					.filter((message) => message.role === "assistant")
					.map((message) => message.errorMessage)
					.filter(Boolean),
			).toEqual([]);
			expect(decisions).toBe(2);
			expect(seen).toHaveLength(1);
			expect(seen[0].some((message) => message.role === "toolResult" && message.toolCallId === "early")).toBe(
				!hardCapacity,
			);
			expect(seen[0].some((message) => message.role === "toolResult" && message.toolCallId === "retained")).toBe(
				!hardCapacity,
			);
			expect(seen[0].some((message) => message.role === "toolResult" && message.toolCallId === "new")).toBe(
				!hardCapacity,
			);
		},
	);
	it("excerpts dispensable results but protects conversation text, errors and images", async () => {
		const source = `BEGIN${"working data ".repeat(4000)}END`;
		const seen: Message[][] = [];
		const requests: DecisionRequest[] = [];
		const parameters = Type.Object({ name: Type.String() });
		const tool: AgentTool<typeof parameters> = {
			name: "inspect",
			label: "inspect",
			description: "inspect",
			parameters,
			async execute(_id, input) {
				if (input.name === "failure") throw new Error("preserve this failure");
				if (input.name === "image")
					return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], details: {} };
				return { content: [{ type: "text", text: source }], details: {} };
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 16000, maxTokens: 100, input: ["text", "image"] }],
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			tools: [tool],
			extensionFactories: [
				createConfiguredDecisionExtension(
					{
						bindings: { "context.retention/v1": { implementation: "fixture", policy: {} } },
						components: { context: { safetyMarginTokens: 0, preserveRecentMessages: 0, excerptChars: 200 } },
					},
					{
						implementations: [
							{
								id: "fixture",
								version: "1",
								definitions: ["context.retention/v1"],
								async evaluate(request) {
									requests.push(request);
									return {
										status: "proposed",
										answer: {
											kind: "score",
											values: Object.fromEntries(
												request.candidates.map((candidate) => [
													candidate.id,
													candidate.id.endsWith(":call") ? 1 : 0,
												]),
											),
										},
									};
								},
							},
						],
					},
				),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: "retain assistant explanation" },
					...["source", "failure", "image"].map((name) => fauxToolCall("inspect", { name }, { id: name })),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				seen.push(structuredClone(context.messages));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("retain user requirement");
		expect(seen).toHaveLength(1);
		expect(requests.flatMap((request) => request.candidates.map((candidate) => candidate.id))).toEqual([
			"source:call",
			"source:result",
		]);
		const messages = seen[0];
		expect(messages.some((message) => getMessageText(message).includes("retain assistant explanation"))).toBe(true);
		expect(messages.some((message) => getMessageText(message).includes("retain user requirement"))).toBe(true);
		const excerpt = getMessageText(
			messages.find((message) => message.role === "toolResult" && message.toolCallId === "source"),
		);
		expect(excerpt).toContain("BEGIN");
		expect(excerpt).toContain("END");
		expect(excerpt).toContain("recall_context");
		expect(excerpt.length).toBeLessThan(500);
		expect(
			messages.find((message) => message.role === "toolResult" && message.toolCallId === "failure"),
		).toMatchObject({ isError: true });
		expect(messages.find((message) => message.role === "toolResult" && message.toolCallId === "image")).toMatchObject(
			{ content: [{ type: "image", data: "aGVsbG8=" }] },
		);
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message) === source,
			),
		).toBe(true);
	});
});
