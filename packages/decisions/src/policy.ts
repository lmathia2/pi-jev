import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Json } from "./contracts.ts";
import { canonicalJson, digestJson } from "./registry.ts";

export interface PolicyArtifact {
	schemaVersion: 1;
	id: string;
	version: string;
	definition: string;
	implementation: string;
	projectionVersion: string;
	policy: Record<string, Json>;
	provenance?: Record<string, Json>;
}

export interface ResolvedPolicy {
	artifact: PolicyArtifact;
	digest: string;
}

export function parsePolicyArtifact(value: unknown): PolicyArtifact {
	canonicalJson(value);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid policy artifact");
	const object = value as Record<string, unknown>;
	const allowed = [
		"schemaVersion",
		"id",
		"version",
		"definition",
		"implementation",
		"projectionVersion",
		"policy",
		"provenance",
	];
	if (Object.keys(object).some((key) => !allowed.includes(key)) || object.schemaVersion !== 1) {
		throw new Error("Unsupported policy fields or schema version");
	}
	for (const key of ["id", "version", "definition", "implementation", "projectionVersion"]) {
		if (typeof object[key] !== "string" || !object[key] || (object[key] as string).includes("@")) {
			throw new Error(`Invalid policy ${key}`);
		}
	}
	for (const key of ["policy", ...(object.provenance === undefined ? [] : ["provenance"])]) {
		if (typeof object[key] !== "object" || object[key] === null || Array.isArray(object[key])) {
			throw new Error(`Invalid policy ${key}`);
		}
	}
	return structuredClone(value) as PolicyArtifact;
}

/** Data-only packages; resolved paths must remain inside the configured package. */
export function loadPolicyPackage(directory: string): PolicyArtifact[] {
	const root = realpathSync(directory);
	const manifest: unknown = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
		throw new Error("Invalid policy manifest");
	const data = manifest as Record<string, unknown>;
	if (
		Object.keys(data).some((key) => !["schemaVersion", "policies"].includes(key)) ||
		data.schemaVersion !== 1 ||
		!Array.isArray(data.policies) ||
		!data.policies.length
	)
		throw new Error("Invalid policy manifest");
	return data.policies.map((file: unknown) => {
		if (typeof file !== "string" || isAbsolute(file)) throw new Error("Invalid policy path");
		const path = realpathSync(resolve(root, file));
		const local = relative(root, path);
		if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error("Policy path escapes package");
		return parsePolicyArtifact(JSON.parse(readFileSync(path, "utf8")));
	});
}

/** Validate the entire replacement before publishing it; versions are immutable even after rollback. */
export class PolicyStore {
	private active = new Map<string, ResolvedPolicy>();
	private known = new Map<string, string>();
	private validate: (artifact: PolicyArtifact) => void;

	constructor(
		validate: (artifact: PolicyArtifact) => void = () => {},
		/** Operator-persisted pins preserve immutable identity across process restarts. */
		expectedDigests: Readonly<Record<string, string>> = {},
	) {
		this.validate = validate;
		for (const [reference, digest] of Object.entries(expectedDigests)) {
			if (
				reference.split("@").length !== 2 ||
				reference.split("@").some((part) => !part) ||
				!/^[a-f0-9]{64}$/.test(digest)
			) {
				throw new Error("Invalid policy digest pin");
			}
			this.known.set(reference, digest);
		}
	}

	activate(values: readonly unknown[]): void {
		const next = new Map<string, ResolvedPolicy>();
		for (const value of values) {
			const artifact = parsePolicyArtifact(value);
			this.validate(structuredClone(artifact));
			const key = `${artifact.id}@${artifact.version}`;
			const digest = digestJson(artifact);
			if (next.has(key) || (this.known.has(key) && this.known.get(key) !== digest)) {
				throw new Error(`Duplicate or mutated policy version: ${key}`);
			}
			next.set(key, { artifact, digest });
		}
		for (const [key, policy] of next) this.known.set(key, policy.digest);
		this.active = next;
	}

	get(reference: string): ResolvedPolicy | undefined {
		const policy = this.active.get(reference);
		return policy ? structuredClone(policy) : undefined;
	}
}
