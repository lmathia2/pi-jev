# Jev decision points: current code review

Reviewed 2026-09-20; updated 2026-09-21. Shadow mode remains removed. `off` is the default; `route` now aliases the guarded `decisions` runtime only with complete decision configuration. Live experiments remain deferred. [ADR 6](adr/0006-bounded-workflows-and-gap-closure.md) and [workflow configuration](jev-workflows.md) supersede the legacy findings and proposal language retained below.

Current gap-closure status: repeated same-phase commands are no-ops; switching assumes cold target inputs for the whole configured horizon; component/skill traces retain invocation metadata; recovery guidance, evidence classification and tool-free specialist consultations are configured workflows; summary requests have shared estimated admission; durable adapters accept host-session reservations across restart. These are tested runtime paths, not claims of measured quality or guaranteed cache savings.

## Implementation checkpoint

The reusable [decision library](../packages/decisions/src/index.ts) now supplies competing implementation plugins, policy manifests, offline paired comparison and learning-artifact conversion. The [design status table](decision-library-design.md#implementation-status) and [implementation log](jev-implementation-log.md) describe what is delivered; [experiments](jev-experiments.md) track remaining measurements.

The normal `AgentSession` has a `before_generation` extension boundary before initial and next-turn prompt/tool construction. The new [routing adapter](../packages/coding-agent/src/jev/decision-routing.ts) supplies private state and complete configured model/effort/tool candidates, checks cache economics, and stores branch-local phase decisions. Phase transitions can come from explicit commands, host callbacks, or the optional `generation.phase/v1` classifier. Classification uses a configured transition graph and independent budget; its usefulness still needs real-task evaluation.

The new [durable adapter](../packages/coding-agent/src/jev/decision-durable.ts) invokes the same registry from `before_generation`. Its host supplies snapshots, phase identity and live admission checks through the intended injected API. The durable driver checkpoints the returned configuration before the request and reuses it for retry; the system-prompt callback receives the chosen configuration directly. This is a separate host integration, not an unfinished CLI routing path.

[Component adapters](../packages/coding-agent/src/jev/decision-components.ts) cover fresh output selection with exact recall, advisory tool review, bounded completion follow-ups and grouped fresh built-in `grep`/`find` results. Truncated retrieval results pass through unchanged. [Skill selection](../packages/coding-agent/src/jev/decision-selection.ts) runs before routing/prompt assembly and retains explicit skills. [Workflows](jev-workflows.md) add evidence classification, recovery guidance and one-shot specialist consultations. Custom retrieval sources still supply candidates through the shared API.

Policy questions and tunable parameters are configurable data. Optional `policyDigests` pins enforce immutable policy content across restarts. No paid optimizer run or automatic live promotion is implemented. Repository checks now pass; see the dated implementation log. Offline checks are not a production-readiness claim.

The opt-in [tool-history context planner](../packages/coding-agent/src/jev/decision-context.ts) uses `context_management` before construction for dispatch, manual compaction and overflow. `context.retention/v1` scores call and result evidence independently; configurable thresholds choose keep, exact excerpt or paired omission. User/assistant text remains unchanged, stored originals remain available through recall discovery, and unjudged or protected interactions stay intact. Insufficient reduction falls back to existing summary compaction. Structural and estimated total-budget admission happen during preparation, not after rendering.

## Legacy route mode and original review baseline

Historical baseline only: the settings-selected legacy path described here has been replaced by the guarded alias/migration diagnostic. Explicit low-level legacy helper exports still exist for custom hosts. Current component responsibilities are in [ADR 5](adr/0005-decision-responsibility-map.md).

The CLI uses `AgentSession` and the ordinary `Agent` loop. Legacy `jev.mode: "route"` routes at `before_agent_start`, once per submitted prompt that starts a run. It receives only `event.prompt` and a cancellation signal. Tool results, the conversation, pending work, current model, and budget are not passed through that older provider contract. Queued steering and subsequent tool turns do not independently invoke the legacy router. New integrations should use `jev.mode: "decisions"` and its pre-prompt boundary.

`packages/agent/src/harness` also contains a durable `AgentHarness`, with lanes, operation state, effect admission, and recovery. Its `before_generation` hook and Jev adapter exist, but are not the execution path used by the normal CLI. Adding a policy there alone does not enable it in the coding agent.

Original Jev helpers retained alongside the new decision adapters:

- [Runtime router](../packages/coding-agent/src/jev/runtime.ts): maps four route IDs to configured profiles; used by normal startup.
- [Durable generation router](../packages/coding-agent/src/jev/generation-router.ts): selects from the same four IDs using the latest user text; host must register it.
- [Candidate selector](../packages/coding-agent/src/jev/client.ts): selects a supplied ID using shortlist, rerank, and fit checks. No automatic skill or specialist dispatch is wired.
- [Context selector](../packages/coding-agent/src/jev/context-selector.ts): returns selected IDs, retaining caller-marked required items. No automatic transcript grouping, retrieval, or context-hook adapter is wired.

## Integration opportunities

The proposed outcomes below are finite IDs. Descriptions, paths, commands, summaries, and follow-up prose remain supplied by existing code or the primary model.

| Priority / component | State to provide | Outcomes | Existing insertion point | Existing default / remaining work |
|---|---|---|---|---|
| 1. Phase-boundary model and effort | Task, recent messages, current phase, prior decisions and outcomes, current model/effort, configured candidates, cache/switch cost | An eligible model–effort pair ID or `keep_current` | New CLI `before_generation` before prompt assembly; `AgentSession._installAgentNextTurnRefresh`; durable `before_generation` | Explicit and optional semantic phase routing with branch records exist. Calibrate judgments and richer state on real tasks; a turn boundary alone must not authorize a model switch. |
| 2. Skill selection | Current task, full loaded skill roster, explicitly requested skills, phase and context pressure | A subset of eligible loaded skill IDs | CLI pre-prompt routing `preparePhase`; durable host resources | Opt-in `skills.select/v1` applies phase-pinned prompt visibility before routing costs; explicit selections survive. It does not install skills. |
| 2. Tool visibility | Task phase, available tool descriptions, current allowlist, required tools | A named tool profile or `keep_current` | Existing route profile `tools`; next-turn refresh; durable `activeToolNames` patch | CLI route profiles already change visibility. Extend state-aware profile selection and explicit required-tool retention; the durable adapter already unions required names. |
| 3. Retrieved context | Query, source IDs/excerpts, current constraints, relevance candidates | Candidate IDs; internally `keep` / `omit` for optional units | Fresh CLI `tool_result`; injected API for custom retrieval | Opt-in `retrieval.rank/v1` groups settled built-in `grep`/`find` hits, protects required groups, skips truncation and provides exact recall. Custom callers supply groups/token budgets; older transcript messages are untouched. |
| 4. Completion verification | Latest answer, task criteria, actual test results, unresolved work, queued input, decision count | `accept`, `verify`, `clarify` | CLI `agent_end` plus follow-up queue; durable `before_run_end` | Existing loop stops when tools and queues are exhausted. Both paths can already accept follow-ups; add a bounded completion policy before inventing a new checkpoint hook. |
| 5. Recovery strategy | Tool error/result, repeated failure count, recent attempts, allowed next actions | `continue`, `inspect`, `switch_profile`, `clarify` | CLI `tool_result` / `turn_end`; durable `after_tool` plus subsequent generation | Model sees error results; transport retries use deterministic backoff. Add semantic recovery for failed work, keeping transport retry limits and abort behavior in code. |
| 6. Specialist dispatch | Bounded subtask, discovered specialists and capabilities, available budgets | A specialist ID or `inline` | Bundled subagent extension; durable host lane dispatch | Example already runs subprocess agents; durable runtime exposes lanes. Reuse candidate selection, but implement the dispatch policy and budget enforcement. Neither is a built-in Jev orchestrator today. |
| 7. Research evidence | Claim, source excerpt, source ID, available evidence | `supports`, `contradicts`, `insufficient` | Research tool result or specialist-output processing, before final synthesis | No Jev evidence-verification policy exists. Semantic relevance helpers can shortlist sources but do not prove that a source supports a claim. Add a separate classification policy. |
| 8. Tool-history context | Token pressure, bounded message overview, complete tool pairs, active constraints | Call/result probabilities mapped to `keep`, `excerpt`, `omit` | Preconstruction CLI `context_management` for dispatch/manual/overflow | Eligible tool interactions only, recall discovery, summary fallback and estimated-budget admission. All user/assistant text stays intact. Jev does not write summaries. |
| Optional. Tool intent check | Validated proposed call, requested task, relevant policy facts | `proceed`, `block`, `request_review` | CLI `tool_call` / core `beforeToolCall`; durable `before_tool` | Schema validation, tool registry checks, and hook blocking exist. An advisory classifier can add review; it cannot confer OS permissions or replace sandboxing. |

## Concrete changes before broader wiring

### Route only at phase changes, using previous decisions

This is a required routing constraint. The normal adapter persists explicit and classifier-selected phase transitions and branch-local decisions. Configure `phaseBinding`, `transitions`, `phaseDescriptions` and `maxPhaseDecisions` to enable classification. Durable-host semantic phase restoration remains host-owned. An assistant message's `commentary`/`final_answer` field is not a semantic phase.

Use an explicit phase ID and sequence at a safe boundary after tool results settle. The implemented finite classifier offers the current phase (stay) plus graph-approved next phases, and runs only on a noninitial generation boundary with a newly settled tool result. A separate budget and persisted per-result check bound classification. Deterministic code validates and persists an allowed transition before routing; stay does not reroute. New user turns, transport retries, tool errors and compaction do not automatically count as phase changes. Initial routing uses the configured initial phase.

At an unchanged phase, reuse the recorded model–effort pair without requesting a new routing decision. At a committed phase change, build eligible pairs from the configured model allowlist and each model's supported/configured reasoning efforts. Jev chooses a pair ID, not arbitrary provider/model strings. Persist both the proposed and applied pair with the phase. Registry presence and credentials establish availability but do not replace the configured allowlist.

Use previous applied decisions and their observed results as input: phase, pair, fallback reason, verification outcome, model/tool calls, token usage, and cache-read/write counts. Rejected proposals should also be recorded to explain why the harness stayed with the current model. Retain a bounded history tied to the session branch; reload and retry must recover the applied decision instead of independently rerouting.

### Charge for switching and preserve cache stability

A phase change permits evaluation of a switch; it does not require one. Pin the pair, tool definitions/order, and stable prompt prefix during the phase. Reasoning-effort and tool changes can themselves affect caching, even when the model ID is unchanged. Dynamic context pruning must therefore account for changes to cached prefixes as well.

Cross-model cache reuse is not a guarantee the harness can provide. Treat a switch as a cold target request unless provider-specific evidence establishes otherwise. Compute costs in TypeScript from configured pricing and measured usage; Jev should assess task fit, not do token arithmetic. Compare estimated remaining-phase cost at the current pair with cold-start plus remaining-phase cost at the proposed pair, including Jev overhead and an uncertainty margin. If expected savings do not clear that margin, retain the current pair. Unknown pricing/cache state should conservatively retain it for cost-driven switches. Capability-driven escalation must be separately identified and bounded by an explicit budget.

Do not insert decision logs into the model-visible system prompt. Store them as metadata and provide a bounded history only to the Jev decision call. Trace estimated switching cost and actual subsequent cache reads/writes so assumptions can be checked.

Provider documentation supports treating cache changes conservatively: [Anthropic's prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes invalidation from thinking configuration changes. The policy above is a proposed harness rule, not a claim of cache portability.

Required tests: no reroute within a phase; one admitted decision per phase transition; recovery reuses the decision; outputs resolve only to configured model–effort pairs; unsupported reasoning levels are rejected before application; prior failure history affects the supplied state; a cheaper model is rejected when cold-start cost exceeds expected savings; unknown cost retains the current pair; no tool/prompt churn within a phase; explicit user model changes take precedence and are recorded.

### Pass state, not only prompt text

For example, the prompt “fix the failure” is insufficient to choose a profile. The same prompt could follow a compiler error, an HTTP 429, or failed citation verification. Build a bounded snapshot with task text, recent relevant messages, latest structured tool outcomes, current configuration, and permitted candidate descriptions.

The normal extension context exposes `sessionManager`, `model`, `thinkingLevel`, `getContextUsage()`, and `hasPendingMessages()`. The new decision adapter reads bounded state from them; the legacy task-only provider does not. The next-turn preparation callback additionally receives the completed assistant response, tool results, and current context.

Give each component a typed input and finite output. Keep a shared Jev transport, timeout handling, result validation, and trace format. Use an explicit default implementation for each component: current profile, normal skill selection, original context, existing finish behavior. Do not require every decision to use the four generation route labels.

Per-definition bindings select registered implementations under `jev.mode: "decisions"`. Output, completion, review, skills, retrieval, recovery, evidence and specialist consultations have configured adapters. Custom retrieval remains injected; durable hosts can reuse their existing session for phase reservations.

### Apply decisions at the correct boundary

With context management enabled, smaller-window route candidates use a conservative pre-render context floor. After routing, `context_management` selects from raw history/current user input and private `promptOverheadTokens`, then validates structure and estimated total budget before prompt construction. There is no postconstruction gate or second ordinary semantic call. Summary fallback runs once before a fresh preparation; residual render/estimate overflow uses provider recovery, not an exact capacity guarantee.

Context `cacheAware` defaults to true for stable-plan reuse and same-plan soft-pressure cost preference; false rejudges each preparation without either. Horizon/margin are configurable through `cacheExpectedRequests` (3) and `cacheMinSavingsUsd` (0). Changed task/phase/configuration/failure state, hard pressure, manual compaction and overflow bypass the preference. Unknown economics allow relevant selection. See [ADR 4](adr/0004-context-window-management.md) for both traces and heuristic token/cache limitations. Dynamic selection covers historical tools and existing skills/retrieval, not all optional prompt materials.

Normal run routing changes live session model/thinking/tools; those values persist into later turns. A profile omitting tools inherits the current tools, potentially including a previous route's restricted list. Decide explicitly whether new profiles are complete presets or patches, and preserve the user's required tools.

For phase-boundary routing, integrate with `_installAgentNextTurnRefresh` before it rebuilds the prompt and snapshots model/tools, but invoke routing only when a phase transition has been admitted. Mutating the model in a context-transformation callback would be too late for a request whose model was already captured. Initial generation needs the corresponding pre-run preparation path.

The durable path captures configuration before admitting the provider request, reusing it on retry. Preserve that behavior. Do not claim the normal `AgentSession` adapter has those same durability guarantees.

### Reuse the existing completion boundary

The prior plan proposed a new `before_checkpoint` hook. The durable `before_run_end` hook already receives messages and can return a follow-up; `finishRunBoundary` checks pending inbox work again before applying it. Start there for completion verification.

The normal session's `_handlePostAgentRun` handles retry/compaction and continues if `agent_end` handlers queued messages. A Jev classifier can select a fixed verification or clarification follow-up. Bound extra passes and check cancellation and pending user input. “Accept” must not discard required tools, queued work, or failed deterministic acceptance checks. The normal loop's `shouldStopAfterTurn` only stops; it is not by itself a general continue/verify controller.

### Separate selection from correctness checks

The shared context helper trusts the caller's `required` flags. The built-in retrieval adapter supplies grouped search results and deterministic required markers; custom callers must supply their own groups and protection. Neither helper discovers arbitrary unresolved transcript calls. Keep selection on retrieved files/documents rather than pruning arbitrary transcript messages.

The current route and rerank requests ask for a selected option and its fit together. If fit is meant to verify the exact selected candidate, a second request must contain that candidate explicitly, or the fit question must instead ask whether any candidate applies. Do not treat questions in one request as sequential instructions.

## Original review findings and regression requirements

These findings describe the legacy helpers and remain useful regression requirements. The shared registry now validates finite answers/probability bounds, isolates inputs, measures failures and supports cancellation; new routing also records effective configuration and phase identity. This does not mean every legacy helper or startup/reload path satisfies all checks below.

1. **Configuration validation:** runtime settings are typed but not fully validated at the JSON boundary. Partial provider/model pairs are silently ignored; thresholds, timeout ranges, and route shapes need validation and diagnostics.
2. **Cancellation:** run routing awaits a decision then mutates settings without rechecking the invocation signal. Recheck before applying any outcome and provide a run-scoped signal during pre-run preparation.
3. **Telemetry isolation:** the routing callback is caught, but `pi.appendEntry` is outside that catch. A persistence failure can prevent the callback and route application. Specify whether durable writes are required or best-effort; do not claim all telemetry failures are isolated.
4. **Requested versus effective configuration:** `applied` records the requested profile, while Pi may clamp thinking levels to model capabilities. Record actual post-application configuration too.
5. **Decision identity:** the current `turn` counter counts prompt starts within an extension instance. It is not a durable generation ID and resets on reload. Add session/run/turn or boundary identity and schema/candidate versions for component tracing.
6. **Missing failure measurements:** successful runtime decisions include Jev model, usage, and duration. Failed or rejected results lose duration in the provider adapter; candidate/context helpers lack equivalent common instrumentation.
7. **Startup coverage:** CLI services and the default SDK loader install routing; callers supplying their own resource loader must register it themselves. Config is captured before resource loading, so project-trust changes during startup and later setting changes need explicit refresh tests.
8. **Validation depth:** the client checks that scores are finite, but not all semantic bounds such as probabilities being in `[0, 1]`. Expand response and cancellation tests before extending the same client to more policies.

See the implementation log for exact coverage. Do not interpret the reusable library as a claim that every legacy helper has been migrated or every host-specific persistence path is complete.

## Implementation order and tests

1. Harden the current routing boundary and add structured state, persisted phase/decision history, configured model–effort candidates, and deterministic switching-cost checks. Test the phase and cache invariants above, disabled/default parity, invalid settings, abort-before-apply, effective configuration, and storage failures.
2. Wire phase-boundary profile/tool selection and skill selection; test the provider request after a real tool turn, explicit skill precedence, and required tools.
3. Wire retrieved-context selection; test no omission of required groups, stable order, fallback parity, and unchanged stored transcript.
4. Add completion verification using existing follow-up mechanisms; test bounded passes, pending input precedence, abort, and durable restart.
5. Add semantic tool recovery, specialist choice, and research evidence classification where concrete tools supply the inputs. Test caller budgets, failed child work, and unsupported citations.
6. Validate tool-history context projection across dispatch, manual compaction and overflow: complete pair handling, unchanged user/assistant text, recall discovery, repeated compaction, restart and preconstruction estimated-budget admission. Arbitrary conversation-text pruning remains out of scope.

Every enabled component should emit boundary identity, candidate IDs, selected outcome, fallback reason, latency, usage when available, and effective action. Keep raw prompts and tool content out of default traces. Offline fixtures and the faux provider remain the verification path until live experiments are explicitly enabled.

## Source map

- [Normal agent loop](../packages/agent/src/agent-loop.ts): `runLoop`, `prepareNextTurn`, `shouldStopAfterTurn`, context conversion, tool preparation and finalization.
- [Normal session](../packages/coding-agent/src/core/agent-session.ts): pre-run routing, next-turn refresh, tool hooks, post-run continuation, retries, and compaction.
- [Extension context](../packages/coding-agent/src/core/extensions/runner.ts): `createContext` and available session state.
- [Durable hook contracts](../packages/agent/src/harness/agent-harness.ts): `HookMap`.
- [Durable generation](../packages/agent/src/harness/runtime/drive/generation.ts): configuration selection and admission.
- [Durable completion](../packages/agent/src/harness/runtime/drive/boundary.ts): `finishRunBoundary`.
- [Subagent example](../packages/coding-agent/examples/extensions/subagent/README.md): existing subprocess dispatch, limits, and cancellation.
