import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Scenario = {
	id: string;
	category: string;
	task: string;
	labels: {
		route: string;
		requiredCapabilities: string[];
		requiresResearch: boolean;
	};
};

type Fixture = {
	schemaVersion: number;
	scenarios: Scenario[];
	metrics: string[];
};

const fixturePath = fileURLToPath(new URL("../evals/fixtures/jev-baseline.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("Jev baseline fixture", () => {
	it("covers each initial workload with stable labels and metrics", () => {
		expect(fixture.schemaVersion).toBe(1);
		expect(new Set(fixture.scenarios.map(({ id }) => id)).size).toBe(fixture.scenarios.length);
		expect(new Set(fixture.scenarios.map(({ category }) => category))).toEqual(
			new Set(["coding", "tool_heavy", "repository_research", "deep_research"]),
		);
		for (const scenario of fixture.scenarios) {
			expect(scenario.id).toMatch(/^[a-z0-9-]+$/);
			expect(scenario.task.length).toBeGreaterThan(20);
			expect(scenario.labels.requiredCapabilities.length).toBeGreaterThan(0);
			expect(scenario.labels.requiresResearch).toBe(scenario.category === "deep_research");
		}
		expect(fixture.metrics).toEqual([
			"completed",
			"regression",
			"durationMs",
			"modelCalls",
			"toolCalls",
			"inputTokens",
			"outputTokens",
			"fallbacks",
		]);
	});
});
