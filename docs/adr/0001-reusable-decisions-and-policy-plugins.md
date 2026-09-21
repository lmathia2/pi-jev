# ADR 1: Reusable decisions and policy plugins

Status: accepted. Date: 2026-09-20.

## Problem

If a Jev adapter constructs its own question and immediately changes the session, a heuristic cannot answer the same question and an offline evaluator cannot compare answers without executing side effects. Embedding policy text in adapters also makes optimization require source edits.

For example, two routing implementations must receive the same authorized candidates and private-state snapshot. Letting each invent a roster measures two different problems.

## Decision

Use `@earendil-works/pi-decisions` as a small, harness-independent proposal library:

1. The host constructs a versioned JSON request with a boundary, state revision, features and finite candidates.
2. The registry captures immutable input identity, validates policy/output, invokes the chosen implementation and applies cancellation/time/invocation limits.
3. The host checks freshness and feasibility, persists the effective decision and applies it. Implementations receive no session/tool handles.

Core imports neither the Jev SDK nor the coding agent. The `/jev` entry point accepts an injected client. Baseline, weighted heuristic, recorded and Jev implementations share contracts; custom implementations register through the same API.

Policies are versioned data artifacts with manifests. Instructions, criteria, probability thresholds and heuristic weights live in JSON; references select the implementation and policy for each definition. `PolicyStore` validates an entire activation before replacing it. Optional `policyDigests` pins reviewed artifact hashes across restarts; in-memory identity alone cannot enforce immutability after restart.

Executable code uses Pi's existing trusted extension loader or direct host injection. JSON does not load arbitrary JavaScript paths. This is dependency/authority separation, not a JavaScript sandbox.

## Consequences

- One registry and existing extension machinery are sufficient; no parallel plugin runtime is necessary.
- Normal startup resolves configuration after project trust. Invalid bundles disable together and report a warning. Resource reload reconstructs the configured extensions; automatic filesystem watching is not implemented.
- Model rosters, required evidence, credentials, budgets and promotion gates are host/operator facts. Learning may propose policy changes, not change its own authority or acceptance tests.
- A custom host still supplies domain-specific features and candidates. The library cannot manufacture trustworthy hidden state for an unrelated harness.

Implementation: [registry](../../packages/decisions/src/registry.ts), [policies](../../packages/decisions/src/policy.ts), [configured adapter](../../packages/coding-agent/src/jev/decision-runtime.ts).
