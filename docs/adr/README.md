# Architecture decisions

Reviewed 2026-09-20. These records describe the implementation, not an assertion that every item in the historical roadmap is complete.

| Record | Decision |
|---|---|
| [1. Reusable decisions and policy plugins](0001-reusable-decisions-and-policy-plugins.md) | One proposal-only library; data policies and existing trusted extension loading |
| [2. Phase boundaries and host authority](0002-phase-boundaries-and-host-authority.md) | Private state before prompt construction; phase pinning, cost admission and synchronous configuration commit |
| [3. Evidence and offline learning](0003-evidence-and-offline-learning.md) | Recoverable selection, immutable comparisons and operator-controlled learning |
| [4. Context-window management](0004-context-window-management.md) | Preconstruction tool-history selection and estimated admission, with optional cache-aware reuse/cost preference |
| [5. Decision responsibility map](0005-decision-responsibility-map.md) | Inputs, proposals, Pi authority, assumptions and limits for every wired decision area |

## Review corrections

- Capturing caller inputs after yielding could evaluate modified data under the wrong identity. The registry now snapshots requests/policies before yielding; sparse JSON arrays are rejected rather than silently hashing like different input.
- Authentication and model notifications introduced a split preset application: a listener could change effort, then routing overwrote it. The host now commits model/effort/tools synchronously before notification; subsequent changes win.
- Initial preparation could signal idle just before generation started. Handover now marks the run active before releasing preparation.
- Startup constructed decisions before project trust/settings reload. Final extension factories now resolve effective settings after trust on every resource reload.
- Parallel output decisions treated sibling audit/original entries as stale harness state. Freshness ignores only those records, retaining checks for real state changes.
- Completion treated any historical tool failure as unresolved, even after a successful identical retry. It now uses the latest result for each tool/argument identity.
- Disabling output selection could strand previously reduced evidence. The shared local recall tool is restored for branches containing saved originals even when inference is off.
- Jev abstentions discarded already-incurred request/token usage. Response-backed rejection and failure paths retain available usage; unreported cost remains unknown.
- Mutable evaluation results and reused variant IDs could corrupt comparison identity. Comparison clones results and rejects conflicting policy identities. Repeated promotion preserves the prior rollback pointer; optional artifact digest pins survive process restarts.
- Skill/retrieval helpers were documented as delivered while normal-session wiring was incomplete. Skills now run before phase routing; retrieval handles built-in `grep`/`find`. Custom retrieval sources remain an explicit API boundary.

## Review scope and verification

Tests target the failures above and lifecycle boundaries using fake providers/implementations, plus the existing library and resource-loader suites. No new testing framework or real-provider suite was introduced. The [implementation log](../jev-implementation-log.md) records passing final checks and the catalog/test fixes that resolved earlier baseline failures.

No production quality or cost claim follows from these tests. Real comparisons and GEPA runs remain in the [experiment queue](../jev-experiments.md). No second plugin installer, search runtime, or optimizer daemon was added.
