# Jev implementation log

## 2026-09-21: close implementation gaps

Branch: `codex/close-decision-gaps`. This checkpoint supersedes the earlier remaining-work statements below.

- Repeated same-phase commands do not append new boundaries or reroute.
- Configured legacy `route` uses the guarded runtime with `decisions`; old partial profiles alone remain unapplied with a migration diagnostic.
- Switch admission prices all target input cold rather than assuming future target cache hits. Current-cache reuse remains a favorable stay estimate; configured work/output/decision overhead are still estimates.
- Component and skill traces retain implementation/version, input/policy digests, latency, request/token counts and known/unknown cost.
- Added opt-in finite recovery guidance, source-ID evidence classification and approved single-request tool-free specialist consultations. Task allowances persist before inference; validation/cancellation/staleness and estimated specialist cost/context limits remain host-owned.
- Durable adapters accept the existing host session as `persistence`, recording lane/phase reservations and policy/roster digests before inference. Explicit `SessionManager.flush()` fixes lazy first-response persistence; disk reopen is regression-tested before inference. The driver still owns applied configuration; host phase/admission callbacks remain required.
- Every summary call checks estimated input/output/margin before provider invocation. Oversized histories fail without silent truncation or deletion.
- README, responsibility map, context/routing ADRs, roadmap and new [ADR 6](adr/0006-bounded-workflows-and-gap-closure.md)/[workflow guide](jev-workflows.md) reflect the code.

Final verification: 174 coding-agent/session/compaction tests and 22 decision-library tests passed (196 total). Two live summarization tests were explicitly skipped with their credential gate unset. `npm run check` passed including TypeScript and browser smoke; `git diff --check` passed. Coverage includes same-phase no-op, legacy guarded alias, full trace metadata, invalid/stale/over-budget specialist rejection, source provenance, bounded recovery, summary admission, and disk reopen before durable inference. Existing npm `min-release-age` compatibility warnings remain; the security setting was not removed. No live experiments, dependency changes or paid provider calls.

Remaining limits are explicit: semantic quality and real cache/cost calibration require experiments; consultations do not execute tools; evidence labels are advisory; exact provider tokenizers/chunked summaries and automatic policy promotion are not implemented. The new paths reuse existing registry, tool, session and provider infrastructure.

## Earlier implementation history

Implementation branch: `codex/jev-decision-library`; isolated merge branch: `codex/jev-merge`. No live inference or optimizer spending was performed. Unrelated worktree changes were preserved.

This implements the reusable foundation and opt-in adapters from the six-step [decision-library design](decision-library-design.md). It does not claim that all integrations in the historical roadmap are production-enabled. Remaining host integrations and experiments are explicit below and in [the experiment queue](jev-experiments.md).

## Phase 1: reusable decisions

Added [`packages/decisions`](../packages/decisions). Requests contain versioned definitions, boundary/revision identity, private JSON features and finite candidates. Registered implementations propose answers; they receive no session/tool execution handles. The registry validates output IDs, isolates inputs, handles cancellation/timeouts, bounds invocations and distinguishes unknown cost from zero.

Implemented keep-current, weighted deterministic heuristic, recorded fixtures and an injected Jev adapter. Core imports do not load the SDK or credentials. Entry-graph checks guard that separation. Jev uses independent candidate judgments rather than pretending questions in one batch execute sequentially.

## Phase 2: policy plugins and configuration

Data-only manifests resolve JSON policy files inside their package directory. `PolicyStore` validates complete replacements and rejects changing the contents of an already-known version. Executable implementations use Pi's existing trusted extension loader and registry; there is no second plugin runtime and no JavaScript path in JSON.

Normal startup supports `jev.mode: "decisions"`. Final extension factories resolve settings after project trust on startup and resource reload. Configuration resolves implementations and policy references before registering any enabled components. Invalid initial bundles disable decisions and report a diagnostic. `policyDigests` optionally enforces reviewed `id@version` artifact pins across restarts. Existing `off` and legacy `route` remain separate. The legacy router does not acquire the new router's phase/cache guarantees.

## Phase 3: stateful routing before generation

Normal `AgentSession` now emits `before_generation` after pre-run prompt-option edits, and at next-turn preparation before assembling prompt sections/tool schemas. Initial preparation has an abort signal. Routing uses private task/state features, prior branch-local decisions, current model/effort/tools, context usage, cache usage and pending-input state.

Complete route presets select model, reasoning effort and tools together. The host commits the preset synchronously after authentication/freshness checks and before notifications; subsequent listener/user changes take precedence. This is not a transactional disk commit. Unsupported efforts, unavailable tools and scoped-model violations are excluded. Smaller windows require active context management and its pre-render feasibility floor plus estimated preparation admission. Required tools cannot disappear through preset inheritance. Decisions are pinned to admitted phases, not ordinary turns or retries. `/decision-phase <configured-name>` selects an explicit next boundary; applications can supply a phase callback.

An optional `generation.phase/v1` binding classifies newly settled tool-result boundaries against the current phase and an operator-approved transition graph. Staying makes no routing call. Permitted transitions are persisted before routing. `maxPhaseDecisions` bounds this separately from routing, and a settled result is not classified twice. Phase instructions/descriptions are configurable and can use the same learning pipeline.

Switch arithmetic compares remaining stay/switch cost and charges a cold target once. Unknown economics cannot establish savings. Capability escalation requires an explicit cost cap. Tariffs, candidate authority and limits are host facts, not learned text. Records contain metadata and effective configuration, not task/tool text.

The durable adapter separately uses `before_generation` and injected snapshot/admission callbacks. Its selected configuration reaches the system-prompt callback before generation and is captured by the existing generation checkpoint. Durable phase/policy identity remains the host's responsibility; the ordinary CLI does not gain transactional crash guarantees from this adapter.

## Phase 4: offline comparison and capture

Paired comparison invokes variants on independent copies of the same request and applies one common admission function without executing tools. It reports label agreement, abstention, invalid/failing decisions, rejection, latency and known/unknown cost. A winning production outcome is never assigned to an unexecuted challenger.

JSONL capture is explicitly consented; full input capture is a separate choice. Metadata-only rows cannot be replayed. Hosts must project/redact sensitive data before inference and capture. Bounded input is not a guarantee that arbitrary task text contains no secrets.

## Phase 5: learning and promotion

Implemented group-safe train/development/holdout splitting, development-only bounded numeric calibration, strict accepted-definition conversion from jev-align, new immutable policy versions, digest-bound heldout gates and explicit promotion/rollback pointers.

Run the [offline roundtrip](../packages/decisions/examples/learning-roundtrip.ts):

```sh
node --experimental-strip-types packages/decisions/examples/learning-roundtrip.ts
```

It exports synthetic training inputs, calibrates on development data, compares a sealed holdout, activates a candidate in `PolicyStore`, and rolls back. It is not a real GEPA optimization or evidence of task-quality improvements. Live activation/report attestation remain operator responsibilities.

## Phase 6: reusable component adapters

- Fresh output selection preserves required evidence and stores an exact branch-local original before trimming. `recall_output` supports exact/ranged recall. Errors, source/diff reads and explicit full-output requests retain the original.
- Tool review receives the proposed call and private context; it can block or require review but cannot grant OS/tool permissions.
- Completion verification uses bounded existing follow-up behavior and respects queued input/cancellation. Follow-up text and limits are configurable.
- Loaded-skill selection runs before route pricing and prompt assembly, retains explicit requests and pins visibility within a phase. Each new phase can select from the full loaded roster.
- Built-in retrieval selection handles grouped `grep`/`find` hits through the shared original-output/recall mechanism. Truncated search results remain unchanged. Custom retrieval backends can supply excerpts/token budgets through the existing helper and extension example; no new search service was added.

These are opt-in, wired normal-session components, not just helper APIs. They do not silently prune arbitrary dialogue. Disabling inference preserves local recall for saved originals. Specialist dispatch, evidence classification and semantic recovery still need concrete host workflows and their own acceptance tests.

## Context-window management

Added `context.retention/v1` with validated complete probability maps and the existing batched Jev transport. The new configured context component classifies calls/results from bounded conversation and private-state projections, then keeps, excerpts or omits complete historical tool pairs without deleting source entries. Narrative, errors, images, recent evidence and recall results are retained. Branch-local plans support reuse and task-change recovery. Context requests share the configured component budget.

Normal generation now routes through `before_generation`, then prepares context selection from raw history/current user input and private `promptOverheadTokens` before constructing the prompt. Structural and estimated total-budget admission run during preparation. There is no postconstruction gate or second ordinary semantic call. Manual/overflow use the same planner. Insufficient selection falls back to existing summarization once, then prepares again before building. Residual estimate/render overflow uses existing provider recovery. The bounded `recall_context` tool supports ID discovery and original text recovery after reload/disable. No new dependencies or storage runtime were added.

Context `cacheAware` defaults to true for stable-plan reuse and same-plan soft-pressure cost preference when the previous view fits. `cacheExpectedRequests` (3) and `cacheMinSavingsUsd` (0) configure horizon/margin; false rejudges each preparation without reuse or cost preference. Changed task/phase/configuration/failure state, hard pressure, manual compaction and overflow bypass that preference. Unknown economics allow relevant selection. Latest same-model cache reads, common-prefix estimates and registry rates do not guarantee cache hits; classifier calls already spent are not recovered.

The implementation uses serialized-size/overhead estimates rather than provider tokenizers and does not guarantee rendered-request fit. The legacy summarizer's own request is not covered. Dynamic selection covers historical tools and existing skills/retrieval, not all optional prompt materials. See [ADR 4](adr/0004-context-window-management.md) for both cache modes and the distinction between reversible selection and lossy summary fallback.

## Configuration example

This baseline example makes no Jev requests. Replace the example provider/model with an authorized model in your registry; unsupported candidates are excluded. Policies and model rosters are data, not generated source.

```json
{
  "jev": {
    "mode": "decisions",
    "decisions": {
      "routing": {
        "binding": { "implementation": "baseline.keep-current", "policy": {} },
        "phases": ["investigate", "implement", "verify"],
        "requiredTools": ["read"],
        "routes": [{
          "id": "approved-low",
          "description": "Approved model with low reasoning",
          "provider": "YOUR_PROVIDER",
          "model": "YOUR_MODEL",
          "effort": "low",
          "tools": ["read", "bash", "edit", "write"]
        }],
        "timeoutMs": 5000,
        "maxDecisions": 100,
        "estimate": { "requests": 3, "outputTokens": 4000, "marginUsd": 0.01, "decisionCostUsd": 0.001 }
      }
    }
  }
}
```

For Jev, supply `TYPESAFE_API_KEY`, add `policyPackages: ["/absolute/path/to/policies"]` and `policyReferences: { "generation.route/v1": "example/routing@1" }` under `decisions`. The [sample package](../packages/decisions/examples/policies/manifest.json) contains all eight configured decision policies. References override inline bindings. Relative package paths resolve against session cwd. Restart or perform a normal resource reload after settings changes; automatic filesystem watching/optimizer activation is not implemented.

To enable phase classification, add `"generation.phase/v1": "example/phases@1"` to `policyReferences`, then set `routing.transitions` (for example `{ "investigate": ["implement"], "implement": ["verify"], "verify": ["implement"] }`), `routing.phaseDescriptions` and `routing.maxPhaseDecisions`. Without that binding, transitions remain explicit. `routing.estimate.initialPromptTokens` optionally supplies a conservative floor for first-request estimates; subsequent estimates also use measured context/cache usage.

Output/retrieval/review/completion use `components` plus matching `bindings` or `policyReferences`. `components.skills: true` additionally requires routing and `skills.select/v1`. Output or retrieval selection combined with routing requires `recall_output` in `requiredTools` and every preset. `maxComponentDecisions` bounds calls per extension instance. Custom executable plugins call `createConfiguredDecisionExtension(settings, { implementations })`; the registry rejects duplicate IDs. The [README](../README.md) has complete enable/disable examples.

## Verification and remaining work

Targeted checks cover library validation, copied snapshots, policy versioning, Jev normalization, learning splits/roundtrip, normal/durable pre-prompt ordering, phase pinning/reload, cost arithmetic, stale proposals, exact recall/branch isolation, required retrieval/skills, review fallback and bounded completion.

Post-review verification: 112 targeted tests passed: 19 decision-library tests, 79 coding-agent routing/component/durable-adapter/startup/resource-loader tests, and 14 durable generation tests. The standalone synthetic learning roundtrip passed. The review also ran nearby model/extension/auth regressions. No provider-backed end-to-end suite was run.

Earlier context-management verification, before the preconstruction-only refinement, passed 65 tests (22 library/Jev/learning and 43 context/routing/components/startup). It covered malformed settings, pairing, excerpts, protected dialogue, plan reuse, restoration, recall, manual/overflow selection, summary fallback and then-current post-render rejection. The post-render gate has since been removed; those counts are historical, not verification of the new flow. That `npm run check` passed formatting and dependency/import/entry-graph/lock checks, then stopped at existing AI model-catalog errors; browser smoke was not reached. npm also reported its existing unsupported `min-release-age` warning.

Final preconstruction verification (2026-09-21): 124 focused tests passed: 22 decision-library tests, 61 coding-agent context/lifecycle/routing/component/startup/durable tests, 40 agent-loop/durable-generation tests, and one offline model-hydration regression. This includes cache-aware versus uncached selection, cache-cost deferral, hard-capacity override, duplicate tool-call IDs, queued input and rebuilding prompts after retry summarization. Browser smoke and `git diff --check` passed separately.

Strict data-only model hydration initially failed because models.dev renamed the Kimi catalog. The generator now accepts the CN catalog key while preserving the existing provider and endpoint; the offline regression verifies this. Hydration and model-data validation passed without hand-editing generated models. The final `npm run check` passed formatting, dependency, import, entry-graph and generated-lock checks, then failed with five existing AI-test type errors: `context-overflow.test.ts` references `mistralai/mistral-large-2512`; `openai-completions-tool-choice.test.ts` references older GLM models; `zai-coding-plan-models.test.ts` references `glm-5.1`, `glm-5v-turbo` and `glm-5.2-highspeed`. Those IDs are absent from the refreshed public catalog. No new decision/lifecycle type errors were reported. npm still warns about its unsupported `min-release-age` setting; that security setting was not removed.

Merge verification: with user approval, updated catalog-dependent tests to current Mistral and GLM entries while retaining pricing, reasoning-effort and overflow assertions. Added the agent test configuration's missing UUID source alias so checks do not depend on prebuilt artifacts. In an isolated worktree with fresh `npm ci --ignore-scripts --offline`, `npm run check` now passes, including TypeScript and browser smoke. Focused verification totals 211 passing tests: 22 decision library, 61 coding-agent decision/lifecycle, 37 existing compaction, 40 agent-loop/durable-generation, and 51 AI fixture/generator tests. The 35 live context-overflow cases were collected in a credential-free, network-disabled environment and skipped; no provider result is claimed. The synthetic learning roundtrip also passed. Existing npm configuration/dependency installation warnings remain; no security setting was removed.

The requested merge is prepared from the isolated branch. Unrelated WebMCP changes, including overlapping root manifest/lockfile hunks, are excluded and remain untouched in the original worktree.

Next engineering tasks: summary-request admission for extreme histories if required; automatic policy activation if required; application-specific durable phase/policy persistence and custom retrieval/recovery/specialist/evidence workflows. Paid comparisons and GEPA training remain unchecked [experiments](jev-experiments.md), not silently run during implementation. See the [ADR review record](adr/README.md) for bugs corrected in this pass.

The implementation reuses Pi's existing extension runtime, follow-up queue, session entries and durable generation checkpoint. It deliberately adds neither a second plugin installer nor a new search/subagent runtime.
