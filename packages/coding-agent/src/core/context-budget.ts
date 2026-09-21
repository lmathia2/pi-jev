import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Tool, toToolDeclaration } from "@earendil-works/pi-ai";
import { convertToLlm } from "./messages.ts";

/** Conservative provider-independent estimate, including system state and tool schemas.
 * ponytail: JSON bytes/3 is not a provider tokenizer; calibrated native counters can replace it later.
 */
export function estimateRequestTokens(messages: AgentMessage[], tools: readonly Tool[] = []): number {
	return Math.ceil(
		Buffer.byteLength(
			JSON.stringify({ messages: convertToLlm(messages), tools: tools.map(toToolDeclaration) }),
			"utf8",
		) / 3,
	);
}

/** Exact, recoverable shortening; shared by planners and final admission. */
export function createContextExcerpt(text: string, chars: number, toolCallId: string): string {
	const half = Math.floor(chars / 2);
	return `${text.slice(0, chars - half)}\n[… ${text.length - chars} characters omitted …]\n${text.slice(-half)}\n[Excerpt; recall_context toolCallId=${JSON.stringify(toolCallId)} retrieves the original in bounded ranges.]`;
}

/** Preserve conversation text and metadata; only complete unambiguous text tool exchanges may shrink. */
export function isSafeContextSelection(original: AgentMessage[], selected: AgentMessage[]): boolean {
	const calls = new Map<string, number[]>();
	const results = new Map<string, number[]>();
	for (const [index, message] of original.entries()) {
		if (message.role === "assistant")
			for (const part of message.content)
				if (part.type === "toolCall") calls.set(part.id, [...(calls.get(part.id) ?? []), index]);
		if (message.role === "toolResult")
			results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), index]);
	}
	const eligible = new Set<string>();
	for (const [id, indices] of results) {
		const call = calls.get(id);
		const result = original[indices[0]];
		if (
			call?.length === 1 &&
			indices.length === 1 &&
			call[0] < indices[0] &&
			result.role === "toolResult" &&
			!result.isError &&
			result.toolName !== "recall_context" &&
			result.content.every((part) => part.type === "text")
		)
			eligible.add(id);
	}
	const omittedCalls = new Set<string>();
	const omittedResults = new Set<string>();
	let cursor = 0;
	for (const message of original) {
		const next = selected[cursor];
		if (JSON.stringify(message) === JSON.stringify(next)) {
			cursor++;
			continue;
		}
		if (message.role === "assistant") {
			const { content, ...metadata } = message;
			let kept: typeof content = [];
			if (next?.role === "assistant") {
				const { content: proposed, ...nextMetadata } = next;
				if (JSON.stringify(metadata) === JSON.stringify(nextMetadata)) {
					kept = proposed;
					cursor++;
				}
			}
			let partIndex = 0;
			for (const part of content) {
				if (JSON.stringify(part) === JSON.stringify(kept[partIndex])) {
					partIndex++;
					continue;
				}
				if (part.type !== "toolCall" || !eligible.has(part.id)) return false;
				omittedCalls.add(part.id);
			}
			if (partIndex !== kept.length) return false;
			continue;
		}
		if (message.role !== "toolResult" || !eligible.has(message.toolCallId)) return false;
		if (next?.role === "toolResult" && next.toolCallId === message.toolCallId) {
			const { content, ...metadata } = message;
			const { content: proposed, ...nextMetadata } = next;
			if (
				JSON.stringify(metadata) !== JSON.stringify(nextMetadata) ||
				proposed.length !== 1 ||
				proposed[0].type !== "text"
			)
				return false;
			const originalText = content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const shortened = proposed[0].text;
			const omitted = [...shortened.matchAll(/\[… (\d+) characters omitted …\]/g)];
			if (
				shortened.length >= originalText.length ||
				!omitted.some((match) => {
					const chars = originalText.length - Number(match[1]);
					return (
						chars >= 2 &&
						chars < originalText.length &&
						createContextExcerpt(originalText, chars, message.toolCallId) === shortened
					);
				})
			)
				return false;
			cursor++;
		} else omittedResults.add(message.toolCallId);
	}
	return (
		cursor === selected.length &&
		omittedCalls.size === omittedResults.size &&
		[...omittedCalls].every((id) => omittedResults.has(id))
	);
}
