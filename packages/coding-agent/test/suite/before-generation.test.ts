import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("keeps waitForIdle pending across preparation-to-generation handoff", async () => {
	const preparing = deferred();
	const prepared = deferred();
	const generating = deferred();
	const generated = deferred();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_generation", async () => {
					preparing.resolve();
					await prepared.promise;
				});
			},
		],
	});
	try {
		harness.setResponses([
			async () => {
				generating.resolve();
				await generated.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = harness.session.prompt("start");
		await preparing.promise;
		let idle = false;
		const idleWait = harness.session.waitForIdle().then(() => {
			idle = true;
		});
		prepared.resolve();
		await generating.promise;
		expect(idle).toBe(false);
		generated.resolve();
		await prompt;
		await idleWait;
		expect(idle).toBe(true);
	} finally {
		prepared.resolve();
		generated.resolve();
		harness.cleanup();
	}
});

it("applies decisions after prompt-option edits and before provider prompt/tool assembly", async () => {
	const order: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "step",
					label: "Step",
					description: "Step",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				pi.on("before_agent_start", (event) => {
					order.push("start");
					event.systemPromptOptions.appendSystemPrompt = "edited before routing";
				});
				pi.on("before_generation", async (event, ctx) => {
					order.push(event.initial ? "initial" : "next");
					expect(event.systemPromptOptions.appendSystemPrompt).toBe("edited before routing");
					expect(event.signal).toBe(ctx.signal);
					const model = ctx.modelRegistry.find(ctx.model!.provider, "second")!;
					await pi.setModel(model);
					pi.setThinkingLevel("high");
					if (event.initial) pi.setActiveTools(["step"]);
					else pi.setActiveTools([]);
				});
			},
		],
		models: [{ id: "first" }, { id: "second", reasoning: true }],
	});
	try {
		harness.setResponses([
			(context) => {
				order.push("request-1");
				expect(harness.session.model!.id).toBe("second");
				expect(harness.session.thinkingLevel).toBe("high");
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["step"]);
				expect(getCurrentSystemPrompt(context.messages)).toContain("edited before routing");
				return fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" });
			},
			(context) => {
				order.push("request-2");
				expect(getCurrentTools(context.messages)).toEqual([]);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("start");
		expect(order).toEqual(["start", "initial", "request-1", "next", "request-2"]);
	} finally {
		harness.cleanup();
	}
});

it("aborts initial decision preparation without generating a provider request", async () => {
	let entered = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_generation", async (event) => {
					entered();
					await new Promise<void>((resolve) =>
						event.signal!.addEventListener("abort", () => resolve(), { once: true }),
					);
				});
			},
		],
	});
	try {
		harness.setResponses([fauxAssistantMessage("unused")]);
		const prompt = harness.session.prompt("start");
		const rejected = expect(prompt).rejects.toThrow();
		await started;
		expect(harness.session.isStreaming).toBe(true);
		await harness.session.abort();
		await rejected;
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isIdle).toBe(true);
	} finally {
		harness.cleanup();
	}
});
