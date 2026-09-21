# Pi decisions

Reusable JSON decisions. Implementations propose finite candidate IDs; only the host can execute an action. The core entry imports no Jev SDK, credentials, agent session, UI, or Chord runtime.

- Core: `DecisionRegistry`, `PolicyStore`, JSON contracts, baseline, weighted heuristic, recorded fixtures.
- `/jev`: injected TypeSafe client adapter; normalized failures and bounded probability checks.
- `/evaluation`: paired offline comparisons, grouped splits, numeric calibration.
- `/learning`: explicit input capture, jev-align conversion, held-out promotion and rollback helpers.

```ts
import { DecisionRegistry, keepCurrentImplementation } from "@earendil-works/pi-decisions";

const registry = new DecisionRegistry();
registry.register(keepCurrentImplementation);
const invocation = await registry.invoke("baseline.keep-current", {
  definition: "generation.route/v1",
  boundaryId: "session:phase:1",
  stateRevision: "revision-1",
  features: { failedChecks: 0 },
  candidates: [{ id: "current", description: "Current model and effort", attributes: {} }],
  currentCandidateId: "current",
});
```

Trusted Pi extensions can register additional `DecisionImplementation` objects through `createConfiguredDecisionExtension({ ... }, { implementations: [...] })`. JSON never imports executable modules. Registration is not a sandbox.

Data-only packages use [manifest.json](examples/policies/manifest.json). Policies carry immutable IDs/versions, definition/projection versions and learnable instructions/parameters. The host owns model authorization, tariffs, tool permissions, deadlines and promotion acceptance tests. Bump the artifact version when changing its contents.

See [implementation status](../../docs/jev-implementation-log.md) and [experiments](../../docs/jev-experiments.md). Paid inference and GEPA optimization are not run during tests or normal package import.
