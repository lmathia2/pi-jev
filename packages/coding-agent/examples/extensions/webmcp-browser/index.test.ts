import { strict as assert } from "node:assert";
import { afterEach, test } from "vitest";
import { MODEL_CONTEXT_BRIDGE_SCRIPT } from "./index.ts";

const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
const originalNavigator = (globalThis as typeof globalThis & { navigator?: unknown }).navigator;

afterEach(() => {
	Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
	Reflect.deleteProperty(globalThis, "__piWebMCPBridge");
});

test("registers, executes, replaces, and unregisters WebMCP tools", async () => {
	Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
	Function(MODEL_CONTEXT_BRIDGE_SCRIPT)();

	type Bridge = {
		registerTool(
			definition: {
				name: string;
				description?: string;
				inputSchema?: Record<string, unknown>;
				execute(args: Record<string, unknown>): unknown;
			},
			options?: { signal?: AbortSignal },
		): Promise<never>;
		list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
		execute(name: string, args: Record<string, unknown>): Promise<unknown>;
	};
	const bridge = (globalThis as typeof globalThis & { __piWebMCPBridge: Bridge }).__piWebMCPBridge;
	const first = new AbortController();
	const firstRegistration = bridge
		.registerTool(
			{ name: "echo", description: "first", execute: ({ value }) => ({ value }) },
			{ signal: first.signal },
		)
		.catch((error: unknown) => error);

	assert.deepEqual(bridge.list(), [
		{ name: "echo", description: "first", inputSchema: { type: "object", properties: {} } },
	]);
	assert.deepEqual(await bridge.execute("echo", { value: "Ada" }), { value: "Ada" });

	const second = new AbortController();
	const secondRegistration = bridge
		.registerTool({ name: "echo", execute: () => "second" }, { signal: second.signal })
		.catch((error: unknown) => error);
	first.abort();
	assert.equal(await bridge.execute("echo", {}), "second");
	assert.equal((await firstRegistration) instanceof DOMException, true);

	second.abort();
	assert.deepEqual(bridge.list(), []);
	assert.equal((await secondRegistration) instanceof DOMException, true);
	await assert.rejects(bridge.execute("echo", {}), /not available/);
});
