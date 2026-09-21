import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createContextRecallExtension } from "../../src/jev/context-recall.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("context recall", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	it("pages current-branch tool results within the configured cap after reload", async () => {
		const harness = await createHarness({ extensionFactories: [createContextRecallExtension({ maxChars: 4 })] });
		harnesses.push(harness);
		const before = harness.sessionManager.appendCustomEntry("fixture", {});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "source",
			toolName: "read",
			content: [{ type: "text", text: "abcdefghij" }],
			isError: false,
			timestamp: Date.now(),
		});
		await harness.session.reload();
		const provider = registerFauxProvider({ api: harness.faux.api, provider: harness.getModel().provider });
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_context", { toolCallId: "source", offset: 2, maxChars: 999999 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("recall");
		const recalled = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
		expect(getMessageText(recalled)).toBe("[Characters 2-6 of 10; next offset: 6]\ncdef");
		expect(recalled).toMatchObject({ details: { offset: 2, end: 6, totalChars: 10, nextOffset: 6 } });
		harness.sessionManager.branch(before);
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_context", { toolCallId: "source" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("recall another branch");
		expect(
			getMessageText(harness.session.messages.filter((message) => message.role === "toolResult").at(-1)),
		).toContain("No tool result with this ID on the current branch");
	});
	it("prefers saved originals over trimmed results and recovers only when context plans exist", async () => {
		const harness = await createHarness({
			extensionFactories: [createContextRecallExtension({ maxChars: 4, recoveryOnly: true })],
		});
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).not.toContain("recall_context");
		harness.sessionManager.appendCustomEntry("decision-context-plan/v1", {});
		harness.sessionManager.appendCustomEntry("decision-original-output/v1", { id: "source", text: "original" });
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "source",
			toolName: "logs",
			content: [{ type: "text", text: "trimmed" }],
			isError: false,
			timestamp: Date.now(),
		});
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_context", { toolCallId: "source", offset: 4 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("recall");
		expect(getMessageText(harness.session.messages.filter((message) => message.role === "toolResult").at(-1))).toBe(
			"[Characters 4-8 of 8; next offset: end]\ninal",
		);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "decision-original-output/v1"),
		).toHaveLength(1);
	});
	it("rejects invalid configured caps", () => {
		for (const maxChars of [0, -1, 1.5, NaN, Infinity, 64001])
			expect(() => createContextRecallExtension({ maxChars })).toThrow("Recall maxChars");
	});
	it("lists discoverable result IDs without an ID using the same bounded pagination", async () => {
		const harness = await createHarness({ extensionFactories: [createContextRecallExtension({ maxChars: 100 })] });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "discover",
			toolName: "read",
			content: [{ type: "text", text: "source text is not duplicated in the index" }],
			isError: false,
			timestamp: Date.now(),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_context", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find omitted sources");
		const result = getMessageText(harness.session.messages.filter((message) => message.role === "toolResult").at(-1));
		expect(result).toContain('{"toolCallId":"discover","toolName":"read"}');
		expect(result).not.toContain("source text");
	});
});
