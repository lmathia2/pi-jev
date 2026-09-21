import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createConfiguredDecisionExtension } from "../../src/jev/decision-runtime.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

it.each(["cost", "stale", "invalid", "failure"])(
	"does not dispatch a specialist after %s rejection",
	async (failure) => {
		const binding = { implementation: "fixture", policy: {} };
		harness = await createHarness({
			models: [{ id: "faux-1", cost: { input: 100, cacheWrite: 100, cacheRead: 10, output: 100 } }],
			tools: [
				{
					name: "source",
					label: "Source",
					description: "Source",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "Evidence" }], details: {} }),
				},
			],
			extensionFactories: [
				createConfiguredDecisionExtension(
					{
						bindings: { "specialist.select/v1": binding },
						components: {
							specialists: {
								maxPerTask: 1,
								timeoutMs: 1000,
								maxOutputTokens: 100,
								maxCostUsd: failure === "cost" ? 0.000001 : 1,
								roster: [
									{
										id: "reviewer",
										description: "Review",
										provider: "faux",
										model: "faux-1",
										effort: "off",
										instructions: "Review evidence",
									},
								],
							},
						},
					},
					{
						implementations: [
							{
								id: "fixture",
								version: "1",
								definitions: ["specialist.select/v1"],
								async evaluate() {
									if (failure === "stale")
										harness!.sessionManager.appendCustomEntry("external-state-change", {});
									if (failure === "failure") throw new Error("transport failed");
									return {
										status: "proposed",
										answer: { kind: "select", candidateId: failure === "invalid" ? "invented" : "reviewer" },
									};
								},
							},
						],
					},
				),
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("source", {}, { id: "s" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("consult_specialist", { task: "Review", sourceIds: ["s"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review");
		expect(harness.faux.state.callCount).toBe(3);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "decision-specialist-usage"),
		).toBe(false);
	},
);

it("wires evidence and isolated specialist consultations through configured decisions", async () => {
	const definitions: string[] = [];
	const binding = { implementation: "fixture", policy: {} };
	harness = await createHarness({
		tools: [
			{
				name: "source",
				label: "Source",
				description: "source",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "The fixture passed." }], details: {} }),
			},
		],
		extensionFactories: [
			createConfiguredDecisionExtension(
				{
					bindings: { "evidence.verify/v1": binding, "specialist.select/v1": binding },
					components: {
						evidence: { maxPerTask: 1 },
						specialists: {
							maxPerTask: 1,
							timeoutMs: 1000,
							maxOutputTokens: 100,
							maxCostUsd: 1,
							roster: [
								{
									id: "reviewer",
									description: "Review evidence",
									provider: "faux",
									model: "faux-1",
									effort: "off",
									instructions: "Review the supplied findings.",
								},
							],
						},
					},
				},
				{
					implementations: [
						{
							id: "fixture",
							version: "1",
							definitions: ["evidence.verify/v1", "specialist.select/v1"],
							async evaluate(request) {
								definitions.push(request.definition);
								return {
									status: "proposed",
									answer: {
										kind: "select",
										candidateId: request.definition === "evidence.verify/v1" ? "supports" : "reviewer",
									},
								};
							},
						},
					],
				},
			),
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("source", {}, { id: "source-1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(
			fauxToolCall("verify_evidence", { task: "Did the fixture pass?", sourceIds: ["source-1"] }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("consult_specialist", { task: "Review this check", sourceIds: ["source-1"] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("The provided check passed [source-1]."),
		fauxAssistantMessage(fauxToolCall("verify_evidence", { task: "Again", sourceIds: ["source-1"] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("check the fixture");
	expect(definitions).toEqual(["evidence.verify/v1", "specialist.select/v1"]);
	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	expect(getMessageText(results[1])).toContain('"selected":"supports"');
	expect(getMessageText(results[2])).toContain("provided check passed");
	expect(getMessageText(results[3])).toContain("budget exhausted");
	expect(harness.session.model?.id).toBe("faux-1");
	expect(
		harness.sessionManager
			.getBranch()
			.some((entry) => entry.type === "custom" && entry.customType === "decision-specialist-usage"),
	).toBe(true);
});

it("rejects invented sources before making semantic calls", async () => {
	let calls = 0;
	harness = await createHarness({
		extensionFactories: [
			createConfiguredDecisionExtension(
				{
					bindings: { "evidence.verify/v1": { implementation: "fixture", policy: {} } },
					components: { evidence: { maxPerTask: 1 } },
				},
				{
					implementations: [
						{
							id: "fixture",
							version: "1",
							definitions: ["evidence.verify/v1"],
							async evaluate() {
								calls++;
								return { status: "abstained", reason: "unused" };
							},
						},
					],
				},
			),
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("verify_evidence", { task: "claim", sourceIds: ["invented"] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("check");
	expect(calls).toBe(0);
	expect(getMessageText(harness.session.messages.find((message) => message.role === "toolResult"))).toContain(
		"Source must be",
	);
});

it("adds bounded recovery guidance without replaying failed side effects", async () => {
	let executions = 0;
	let decisions = 0;
	harness = await createHarness({
		tools: [
			{
				name: "fail",
				label: "Fail",
				description: "Fail",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					throw new Error("Original failure");
				},
			},
		],
		extensionFactories: [
			createConfiguredDecisionExtension(
				{
					bindings: { "recovery.action/v1": { implementation: "fixture", policy: {} } },
					components: { recovery: { tools: ["fail"], maxPerTask: 1 } },
				},
				{
					implementations: [
						{
							id: "fixture",
							version: "1",
							definitions: ["recovery.action/v1"],
							async evaluate() {
								decisions++;
								return { status: "proposed", answer: { kind: "select", candidateId: "inspect" } };
							},
						},
					],
				},
			),
		],
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("fail", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("fail", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("inspect failure");
	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	expect(getMessageText(results[0])).toContain("Original failure");
	expect(getMessageText(results[0])).toContain("Recovery guidance");
	expect(getMessageText(results[1])).not.toContain("Recovery guidance");
	expect(executions).toBe(2);
	expect(decisions).toBe(1);
});
