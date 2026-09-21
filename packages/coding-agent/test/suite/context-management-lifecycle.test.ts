import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import * as systemPrompt from "../../src/core/system-prompt.ts";
import { createHarness } from "./harness.ts";

it("preserves distinct original results when tool-call IDs repeat", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("context_management", (event) => ({
					action: "selected",
					messages: event.messages,
					maxInputTokens: 100000,
				}));
			},
		],
	});
	try {
		for (const text of ["first original", "second original"]) {
			harness.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "duplicate" })));
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "duplicate",
				toolName: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: Date.now(),
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			(context) => {
				expect(
					context.messages.filter((message) => message.role === "toolResult").map((message) => message.content),
				).toEqual([[{ type: "text", text: "first original" }], [{ type: "text", text: "second original" }]]);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("continue");
	} finally {
		harness.cleanup();
	}
});

it("selects raw current input after routing and before prompt construction, preserving legacy context edits", async () => {
	const order: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_generation", () => {
					order.push("route");
				});
				pi.on("context_management", async (event) => {
					order.push("select");
					expect(event.messages.some((message) => message.role === "system")).toBe(false);
					expect(JSON.stringify(event.messages)).toContain("current task");
					expect(event.promptOverheadTokens).toBeGreaterThan(0);
					expect(event.promptIdentity).toHaveLength(64);
					await harness.session.steer("late steering");
					return { action: "selected", messages: event.messages, maxInputTokens: 100000 };
				});
				pi.on("context", (event) => ({
					messages: [
						...event.messages,
						{ role: "user", content: [{ type: "text", text: "legacy addition" }], timestamp: 2 },
					],
				}));
			},
		],
	});
	const original = systemPrompt.buildSystemPromptSections;
	const spy = vi.spyOn(systemPrompt, "buildSystemPromptSections").mockImplementation((options) => {
		order.push("build");
		return original(options);
	});
	try {
		harness.setResponses([
			(context) => {
				order.push("provider");
				expect(JSON.stringify(context.messages)).toContain("legacy addition");
				expect(JSON.stringify(context.messages)).toContain("late steering");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("current task");
		expect(order).toEqual(["route", "select", "build", "provider"]);
	} finally {
		spy.mockRestore();
		harness.cleanup();
	}
});

it("cancels context preparation before summary or provider dispatch", async () => {
	let entered = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("context_management", async (event) => {
					entered();
					await new Promise<void>((resolve) =>
						event.signal!.addEventListener("abort", () => resolve(), { once: true }),
					);
					return { action: "compact", maxInputTokens: 1 };
				});
			},
		],
	});
	try {
		const prompt = harness.session.prompt("start").catch((error: unknown) => error);
		await started;
		await harness.session.abort();
		await prompt;
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	} finally {
		harness.cleanup();
	}
});

it("manual selection succeeds without a summary request or replacing session history", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("context_management", (event) => {
					expect(event.reason).toBe("manual");
					return {
						action: "selected",
						messages: event.messages,
						maxInputTokens: event.model.contextWindow - event.reserveTokens,
					};
				});
			},
		],
	});
	try {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "retained original" }],
			timestamp: 1,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = structuredClone(harness.sessionManager.getBranch());
		expect(await harness.session.compact()).toMatchObject({ strategy: "selection", summary: "" });
		expect(harness.sessionManager.getBranch()).toEqual(before);
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("preparation falls back to one summary and replans before prompt construction", async () => {
	const reasons: string[] = [];
	const harness = await createHarness({
		settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("context_management", (event) => {
					reasons.push(event.reason);
					const maxInputTokens = event.model.contextWindow - event.reserveTokens;
					return event.reason === "prepare"
						? { action: "compact", maxInputTokens }
						: { action: "selected", messages: event.messages, maxInputTokens };
				});
			},
		],
	});
	try {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old original" }],
			timestamp: 1,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("summary checkpoint"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("summary checkpoint");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("new task");
		expect(reasons).toEqual(["prepare", "prepare-after-summary"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(JSON.stringify(harness.sessionManager.getBranch())).toContain("old original");
	} finally {
		harness.cleanup();
	}
});

it("refuses an oversized required prompt even when a selection handler claims it fits", async () => {
	const harness = await createHarness({
		models: [{ id: "small", contextWindow: 1024 }],
		tools: [],
		settings: { retry: { enabled: false }, compaction: { reserveTokens: 32, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("context_management", (event) => ({
					action: "selected",
					messages: event.messages,
					maxInputTokens: 1e9,
				}));
			},
		],
	});
	try {
		harness.setResponses([fauxAssistantMessage("must not dispatch")]);
		await expect(harness.session.prompt("required input ".repeat(2000))).rejects.toThrow("Context capacity exceeded");
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it.each([false, true])(
	"tries selection on overflow and rebuilds before retry (summary fallback: %s)",
	async (summarize) => {
		const reasons: string[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("context_management", (event) => {
						reasons.push(event.reason);
						if (summarize && event.reason === "overflow") return { action: "compact", maxInputTokens: 100000 };
						return {
							action: "selected",
							messages: event.messages,
							maxInputTokens: event.model.contextWindow - event.reserveTokens,
						};
					});
				},
			],
		});
		const build = vi.spyOn(systemPrompt, "buildSystemPromptSections");
		try {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "earlier task" }],
				timestamp: 1,
			});
			harness.sessionManager.appendMessage(fauxAssistantMessage("earlier answer"));
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
				...(summarize ? [fauxAssistantMessage("summary checkpoint")] : []),
				fauxAssistantMessage("recovered"),
			]);
			await harness.session.prompt("task");
			expect(reasons).toEqual(["prepare", "overflow", "prepare"]);
			expect(harness.faux.state.callCount).toBe(summarize ? 3 : 2);
			expect(build).toHaveBeenCalledTimes(2);
			if (!summarize)
				expect(harness.eventsOfType("compaction_end")).toContainEqual(
					expect.objectContaining({
						reason: "overflow",
						result: expect.objectContaining({ strategy: "selection" }),
					}),
				);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
				summarize ? 1 : 0,
			);
		} finally {
			build.mockRestore();
			harness.cleanup();
		}
	},
);
