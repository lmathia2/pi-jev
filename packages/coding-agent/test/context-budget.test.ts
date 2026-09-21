import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createContextExcerpt, isSafeContextSelection } from "../src/core/context-budget.ts";

it("admits only exact recoverable excerpts and paired omissions, preserving narrative and errors", () => {
	const original: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 },
		fauxAssistantMessage([{ type: "text", text: "reasoning narrative" }, fauxToolCall("read", {}, { id: "call" })]),
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "original ".repeat(100) }],
			isError: false,
			timestamp: 3,
		},
	];
	const assistant = original[1];
	const result = original[2];
	if (assistant.role !== "assistant" || result.role !== "toolResult") throw new Error("fixture");
	const narrative = { ...assistant, content: assistant.content.filter((part) => part.type !== "toolCall") };
	expect(isSafeContextSelection(original, [original[0], narrative])).toBe(true);
	expect(isSafeContextSelection(original, [original[0], narrative, result])).toBe(false);
	expect(isSafeContextSelection(original, [original[0]])).toBe(false);
	const text = "original ".repeat(100);
	const excerpt = { ...result, content: [{ type: "text" as const, text: createContextExcerpt(text, 100, "call") }] };
	expect(isSafeContextSelection(original, [original[0], assistant, excerpt])).toBe(true);
	const oddExcerpt = createContextExcerpt(text, 101, "call");
	expect(oddExcerpt).toContain(`${text.slice(0, 51)}\n[… 799 characters omitted …]\n${text.slice(-50)}`);
	expect(
		isSafeContextSelection(original, [
			original[0],
			assistant,
			{ ...result, content: [{ type: "text", text: oddExcerpt }] },
		]),
	).toBe(true);
	expect(
		isSafeContextSelection(original, [
			original[0],
			assistant,
			{ ...excerpt, content: [{ type: "text", text: "invented" }] },
		]),
	).toBe(false);
	expect(
		isSafeContextSelection([original[0], assistant, { ...result, isError: true }], [original[0], narrative]),
	).toBe(false);
});
