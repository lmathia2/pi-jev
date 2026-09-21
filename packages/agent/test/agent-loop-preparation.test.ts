import {
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentMessage } from "../src/types.ts";

it.each([false, true])(
	"exposes known input during preparation and preserves late steering (alreadyQueued=%s)",
	async (alreadyQueued) => {
		const provider = registerFauxProvider();
		try {
			const earlier: AgentMessage = { role: "user", content: "earlier", timestamp: 1 };
			const later: AgentMessage = { role: "user", content: "later", timestamp: 2 };
			const queue: AgentMessage[] = [];
			const snapshots: (readonly AgentMessage[])[] = [];
			const providerUsers: string[][] = [];
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
				(context) => {
					providerUsers.push(
						context.messages
							.filter((message) => message.role === "user")
							.map((message) => String(message.content)),
					);
					return fauxAssistantMessage("first prepared");
				},
				(context) => {
					providerUsers.push(
						context.messages
							.filter((message) => message.role === "user")
							.map((message) => String(message.content)),
					);
					return fauxAssistantMessage("second prepared");
				},
			]);
			const stream = agentLoop(
				[{ role: "user", content: "initial", timestamp: 0 }],
				{
					messages: [],
					tools: [
						{
							name: "echo",
							label: "echo",
							description: "echo",
							parameters: Type.Object({}),
							execute: async () => {
								if (alreadyQueued) queue.push(earlier);
								return { content: [], details: {} };
							},
						},
					],
				},
				{
					model: provider.getModel(),
					apiKey: "faux-key",
					convertToLlm: (messages) =>
						messages.filter((message) =>
							["system", "user", "assistant", "toolResult"].includes(message.role),
						) as Message[],
					getSteeringMessages: async () => queue.splice(0, 1),
					prepareNextTurn: async ({ pendingMessages }) => {
						snapshots.push(pendingMessages);
						if (snapshots.length === 1) {
							await Promise.resolve();
							queue.push(later);
						}
						return undefined;
					},
				},
				undefined,
				streamSimple,
			);
			const result = await stream.result();
			expect(snapshots).toEqual(alreadyQueued ? [[earlier], [later]] : [[]]);
			expect(providerUsers).toEqual(
				alreadyQueued
					? [
							["initial", "earlier"],
							["initial", "earlier", "later"],
						]
					: [["initial", "later"]],
			);
			expect(result.filter((message) => message.role === "user" && message.content === "later")).toHaveLength(1);
		} finally {
			provider.unregister();
		}
	},
);
