import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("hydrates the renamed Kimi CN catalog without changing pi's provider or endpoint", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kimi-generation-"));
	try {
		const preload = join(root, "catalog.mjs");
		const output = join(root, "output");
		const catalog = {
			"kimi-code-plan-cn": { models: { "kimi-for-coding": { id: "kimi-for-coding", tool_call: true } } },
			"kimi-code-plan-global": { models: { "global-only": { id: "global-only", tool_call: true } } },
		};
		writeFileSync(
			preload,
			`const catalog = ${JSON.stringify(catalog)};
globalThis.fetch = async (input) => {
 const url = String(input);
 if (url === "https://models.dev/api.json") return Response.json(catalog);
 if (url === "https://openrouter.ai/api/v1/models" || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({data: []});
 throw new Error("Unexpected fetch: " + url);
};`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				output,
			],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const models = JSON.parse(readFileSync(join(output, "providers/kimi-coding.json"), "utf8"));
		expect(Object.keys(models)).toEqual(["kimi-for-coding"]);
		expect(models["kimi-for-coding"]).toMatchObject({
			provider: "kimi-coding",
			api: "anthropic-messages",
			baseUrl: "https://api.kimi.com/coding",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
