import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/settings-manager.ts";
import { createConfiguredGenerationRoutingExtension } from "../../src/jev/runtime.ts";
import { createHarness } from "./harness.ts";

it.each([false, true])(
	"constructs decisions only from finalized project trust=%s, and recreates them on reload",
	async (trusted) => {
		const harness = await createHarness();
		try {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ jev: { mode: "off" } }));
			storage.withLock("project", () => JSON.stringify({ jev: { mode: "decisions" } }));
			const settings = SettingsManager.fromStorage(storage);
			const readSettings = vi.spyOn(settings, "getJevSettings");
			const services = await createAgentSessionServices({
				cwd: harness.tempDir,
				agentDir: join(harness.tempDir, "agent"),
				modelRuntime: harness.session.modelRuntime,
				settingsManager: settings,
				resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true },
				resourceLoaderReloadOptions: {
					resolveProjectTrust: async ({ extensionsResult }) => {
						expect(readSettings).not.toHaveBeenCalled();
						expect(extensionsResult.extensions).toHaveLength(0);
						return trusted;
					},
				},
			});
			expect(readSettings).toHaveBeenCalledTimes(1);
			expect(readSettings.mock.results[0].value.mode).toBe(trusted ? "decisions" : "off");
			expect(services.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual(
				trusted
					? ["<final:decision-recall>", "<final:context-recall>", "<final:configured-decisions>"]
					: ["<final:decision-recall>", "<final:context-recall>"],
			);
			storage.withLock("global", () => JSON.stringify({ jev: { mode: "off" } }));
			storage.withLock("project", () => JSON.stringify({ jev: { mode: "off" } }));
			await services.resourceLoader.reload();
			expect(readSettings).toHaveBeenCalledTimes(2);
			expect(services.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
				"<final:decision-recall>",
				"<final:context-recall>",
			]);
			expect(createConfiguredGenerationRoutingExtension({ mode: "off" })).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	},
);
