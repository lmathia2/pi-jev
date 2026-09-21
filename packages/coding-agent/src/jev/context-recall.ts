import { Type } from "typebox";
import type { InlineExtension, ToolDefinition } from "../core/extensions/types.ts";

/** Recover text from the current branch, without duplicating session history or reading external files. */
export function createContextRecallExtension(
	options: { maxChars?: number; recoveryOnly?: boolean } = {},
): InlineExtension {
	const cap = options.maxChars ?? 4000;
	if (!Number.isSafeInteger(cap) || cap < 1 || cap > 64000) throw new Error("Recall maxChars must be 1..64000");
	const parameters = Type.Object({
		toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
	});
	const tool: ToolDefinition<typeof parameters> = {
		name: "recall_context",
		label: "Recall context",
		description: `Read original tool-result text on the current session branch. Omit toolCallId to list available IDs and tool names. Offset counts zero-based characters for both lists and results; each call returns at most ${cap} characters of source text.`,
		parameters,
		async execute(_id, params, signal, _update, context) {
			signal?.throwIfAborted();
			const offset = params.offset ?? 0;
			const requested = params.maxChars ?? cap;
			if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requested) || requested < 1)
				throw new Error("Invalid recall character range");
			const branch = context.sessionManager.getBranch();
			let original: string | undefined;
			if (params.toolCallId === undefined) {
				const available = new Map<string, string>();
				for (const entry of branch) {
					if (entry.type === "message" && entry.message.role === "toolResult")
						available.set(entry.message.toolCallId, entry.message.toolName);
					if (entry.type === "custom" && entry.customType === "decision-original-output/v1") {
						const data = entry.data as { id?: unknown; text?: unknown } | undefined;
						if (typeof data?.id === "string" && typeof data.text === "string" && !available.has(data.id))
							available.set(data.id, "saved output");
					}
				}
				original = [...available]
					.map(([toolCallId, toolName]) => JSON.stringify({ toolCallId, toolName }))
					.join("\n");
			}
			for (let index = branch.length - 1; original === undefined && index >= 0; index--) {
				const entry = branch[index];
				if (entry.type !== "custom" || entry.customType !== "decision-original-output/v1") continue;
				const data = entry.data as { id?: unknown; text?: unknown } | undefined;
				if (data && data.id === params.toolCallId && typeof data.text === "string") {
					original = data.text;
					break;
				}
			}
			if (original === undefined) {
				for (let index = branch.length - 1; index >= 0; index--) {
					const entry = branch[index];
					if (
						entry.type !== "message" ||
						entry.message.role !== "toolResult" ||
						entry.message.toolCallId !== params.toolCallId
					)
						continue;
					original = entry.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					break;
				}
			}
			if (original === undefined) throw new Error("No tool result with this ID on the current branch");
			if (offset > original.length) throw new Error("Recall offset exceeds original text length");
			const text = original.slice(offset, offset + Math.min(requested, cap));
			const end = offset + text.length;
			const nextOffset = end < original.length ? end : null;
			return {
				content: [
					{
						type: "text",
						text: `[Characters ${offset}-${end} of ${original.length}; next offset: ${nextOffset ?? "end"}]\n${text}`,
					},
				],
				details: { toolCallId: params.toolCallId, offset, end, totalChars: original.length, nextOffset },
			};
		},
	};
	return {
		name: "context-recall",
		hidden: true,
		factory(pi) {
			if (!options.recoveryOnly) pi.registerTool(tool);
			else
				pi.on("session_start", (_event, context) => {
					if (
						context.sessionManager
							.getBranch()
							.some((entry) => entry.type === "custom" && entry.customType === "decision-context-plan/v1") &&
						!pi.getAllTools().some((candidate) => candidate.name === tool.name)
					)
						pi.registerTool(tool);
				});
		},
	};
}
