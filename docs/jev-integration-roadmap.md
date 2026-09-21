# Jev integration roadmap

Reviewed 2026-09-20 against the current harness and 29 public Pi/Jev implementations. Three ecosystem indexes were also checked for omissions. This roadmap narrows the broader [decision-point review](jev-decision-points.md) to changes justified by source implementations or measurements.

The [decision-library design](decision-library-design.md) defines the reusable package, implementation plugins, comparison protocol, policy artifacts, and learning workflow. Its foundation-first delivery sequence supersedes the ordering below; the sections below describe component scope.

## Implementation checkpoint

2026-09-21 gap closure: same-phase commands are idempotent; legacy settings cannot bypass guarded routing; target cache hits no longer finance switches; full invocation metadata survives component/skill adapters; bounded recovery, source-evidence and specialist consultations are wired. Summary requests now have shared admission, and durable routing can persist reservations in the host session. See [ADR 6](adr/0006-bounded-workflows-and-gap-closure.md) and [configuration](jev-workflows.md). Later phase descriptions retain original acceptance goals, not promises that live measurements have been performed.

The [implementation log](jev-implementation-log.md) records code and verification. The [experiment queue](jev-experiments.md) separates correctness checks from useful-behavior measurements.

- Foundation: `packages/decisions` now supplies implementation plugins, validated proposals, data-only policy manifests, offline paired comparison, consented JSONL capture/export, strict jev-align text conversion, numeric calibration and explicit promotion/rollback helpers.
- Routing: `jev.mode: "decisions"` enables the new configurable adapters. Normal routing executes before prompt/tool assembly, selects complete model/effort/tool presets and records phase decisions on the branch. Phases can be explicit (`/decision-phase`), host-supplied, or classified using optional `generation.phase/v1` with `phaseBinding`, `transitions`, `phaseDescriptions` and `maxPhaseDecisions`. Classification occurs once per newly settled tool-result boundary, only for noninitial generations, under its own budget. Staying in the current phase does not reroute; an allowed transition is persisted before routing. Real-task calibration remains outstanding.
- Durable host: the shared-library router is available as an opt-in `before_generation` handler. It accepts private snapshots and host admission checks. The driver persists complete configuration before provider admission and exposes it to prompt generation. Phase/policy state is intentionally supplied by the integrating host, not a missing CLI feature.
- Components: fresh output, advisory tool review and bounded completion have opt-in extension adapters. Skill selection uses the full loaded roster through routing's `preparePhase`, pins visibility per phase, preserves explicit skills and finishes before prompt assembly and routing costs. Built-in retrieval selection groups fresh settled `grep`/`find` hits, preserves required groups and exact originals for recall, and skips truncated results. Custom retrieval sources use an injected candidate/token-budget API; no old transcript pruning is performed.
- Policies: semantic instructions and tunable parameters are configuration data. Optional `policyDigests` SHA-256 pins keyed by `id@version` enforce immutable artifacts across restarts; unpinned versions are immutable only within a running store.
- Tool-history context: preconstruction `context_management` shares one planner across dispatch, manual compaction and overflow. Independent `context.retention/v1` call/result probabilities drive configurable keep/excerpt/omit decisions over complete tool interactions. User/assistant text is unchanged; exact originals remain discoverable through recall. Existing summaries are the fallback when reduction is insufficient. Estimated total-budget admission occurs before rendering; no postconstruction gate guarantees fit.
- Learning: offline functions and synthetic checks are implemented; actual GEPA runs, dataset review, calibration from real sessions and live promotion have not been performed. A candidate's own metrics cannot satisfy the operator's release gate.

The phases below retain acceptance checks, not a claim that every measurement passed. Automatic policy reload, provider-specific cache calibration and the explicitly deferred work remain outside the delivered scope. Repository checking now passes; offline tests do not establish production readiness or semantic quality.

## Goal

Use Jev only for bounded semantic decisions whose candidates and consequences are controlled by Pi. Deterministic code continues to own validation, permissions, budgets, retries, tool execution, persistence, and fallback behavior.

The default remains ordinary Pi behavior. Each Jev component is independently enabled and fails back to that behavior.

## What the ecosystem demonstrates

| Area | Useful pattern | Sources | Decision for Pi-Jev |
|---|---|---|---|
| Shared client | One authenticated client, bounded requests, cancellation, usage accounting, typed validation | `pi-typesafe`, `pi-warden`, `pi-jev-auto-mode` | Reuse the independent `packages/decisions` registry and isolated Jev adapter; harness-specific state belongs in `packages/coding-agent/src/jev`. |
| Model routing | Choose among configured model/effort IDs; validate availability and budget in code | `pi-jev-model-router`, `pi-jev-task-router`, `pi-router`, `pi-fusion-matrix`, `pi-jev` variants | Keep routing, but move it from every prompt to admitted task-phase changes. |
| Tool and skill selection | Rank a bounded roster and preserve explicit selections | `TheoOliveira/pi-jev`, `pi-jev-tools`, `jev-agent-hooks`, `pi-jev-harness` | Reuse finite decision contracts over loaded skills and configured complete tool profiles; never let Jev invent names. |
| Fresh tool output | Trim before the output first enters model context; keep exact text and provide lossless recall | `pi-jev-context`, `pi-warden` | Highest-value new integration after client hardening. |
| Retrieved evidence | Rank caller-supplied excerpts, then require ordinary reads before claims | `pi-jev-tools`, `madeye/pi-jev`, `pi-jev-code` | Add to retrieval paths, not arbitrary transcript rewriting. |
| Completion checks | Compare a final claim with concrete acceptance evidence and choose a bounded follow-up | `pi-warden`, `pi-jev-code`, `oh-my-plumb`, `pi-review` | Add after routing/context metrics exist; deterministic failed checks always win. |
| Tool permissions | Deterministic safe/deny rules first; semantic judgment only for an uncertain middle band | `pi-jev-auto-mode`, `pi-verdict`, `pi-jev-gate`, `specpi-jev-guard`, `bicameral` | Optional advisory/review layer only. Jev cannot grant OS authority or replace sandboxing. |
| Old-history pruning | Per-call keep/drop decisions can retain verbatim evidence | compaction projects and context curators | Limited tool-pair provider projection is implemented with exact recall and summary fallback. Arbitrary conversation-text pruning remains deferred; retention quality still requires real-session evidence. |

## Common decision runtime

Extract reusable decision contracts into `packages/decisions`, with an isolated Jev adapter entry point. Keep harness state extraction and action application in the coding agent. See the decision-library design for the dependency boundary.

The runtime must provide:

- one invocation path with registered implementations and adapter-owned clients;
- request timeout plus caller cancellation, rechecked before applying a result;
- schema and numeric-bound validation, including probabilities in `[0, 1]`;
- a per-session request/input-token budget and bounded concurrency;
- a stable decision identity: session branch, run, boundary, component, schema version, and candidate-set version;
- privacy-safe records containing candidate IDs, outcome, fallback, duration, usage, and effective action, but no raw prompt, file content, tool output, or key;
- explicit component fallback functions, not a shared implicit fallback;
- optional recorded responses for deterministic replay tests.

Use a small implementation registry and schema-validated policy artifacts. Prove the boundary with keep-current, heuristic, recorded-fixture, and Jev implementations of routing before extending it to other decisions.

## Learnable policy contract

Anything that expresses semantic judgment must be data, not TypeScript constants. The runtime loads versioned policy bundles; GEPA, `jev-align`, or another optimizer can improve those bundles offline without changing harness code.

Learnable/configurable fields include:

- Jev instructions and Choice/Noul/Score criteria;
- phase descriptions and transition preferences within an operator-approved graph; IDs and semantics stay fixed during an optimization experiment;
- model, effort, skill, and tool-profile candidate descriptions;
- confidence, fit, abstention, escalation, and switching-margin thresholds;
- state-field inclusion, bounded history counts, truncation limits, and semantic feature descriptions;
- cost-model coefficients and uncertainty margins where measured data can fit them;
- acquisition parameters within an operator-approved experiment budget.

Evaluation metrics, held-out splits, promotion thresholds, component enablement, model allowlists, maximum spend, data-access scope, and active policy versions are operator configuration. Optimizers cannot modify their own acceptance criteria or expand their authority.

The following remain code because learning must not weaken runtime invariants:

- input/output schemas and finite outcome validation;
- authentication, availability, capability, context-window, and budget enforcement;
- permission and sandbox boundaries;
- secret removal and maximum payload sizes;
- cancellation, timeout, retry, and fallback behavior;
- required tool/context retention, tool-call/result pairing, and lossless recall;
- cache accounting mechanics and the rule that unknown cache/cost state preserves the current route;
- decision persistence, audit identity, and explicit user override precedence.

### Policy bundle

Use one small JSON file per decision component under a configurable policy directory, with built-in files supplying the defaults. Global and trusted-project settings select policy files; they do not duplicate their contents inside `settings.json`.

Each bundle contains:

- `schemaVersion`, component ID, policy version, and optional source digest;
- task type: binary, multiclass, multilabel, or ordered score;
- declared input fields and their maximum serialized sizes;
- instructions and fixed outcome criteria;
- thresholds and tunable numeric parameters;
- allowed outcome IDs or candidate-set contract;
- training provenance and metrics: optimizer, dataset digest, train/holdout counts, metric, score, and acceptance time.

Runtime loading is strict. Unknown fields, missing criteria, duplicate outcomes, invalid probability ranges, oversized definitions, incompatible component IDs, or unsupported schema versions reject the entire update and retain the last valid configuration. At first startup with no valid configuration, use the component's host-defined fallback and report the error. Loading a bundle cannot add tools, models, permissions, or executable code.

Candidate-dependent routing data remains runtime state. The policy defines how to judge candidates; current model IDs, prices, capabilities, authentication, cache measurements, and budgets are supplied by the harness on each admitted decision.

### Learning data and optimizer bridge

Every applied or rejected decision can emit an opt-in, privacy-bounded learning record containing:

- policy and candidate-set versions;
- the exact normalized feature object seen by the decision function, after redaction and bounds;
- returned probabilities/confidence, selected outcome, deterministic rejection reason, and effective action;
- later observable outcomes such as phase duration, retries, verification result, cache reads/writes, token cost, recall requests, and user override;
- an optional human label and rationale.

Keep raw prompts, repository content, tool output, secrets, and credentials out by default. A separate explicit export command produces JSONL/CSV suitable for `jev-align`, GEPA, or equivalent optimizers. Training never runs in the agent loop.

An optimizer proposal must preserve the bundle's component ID, input schema, outcome IDs, and hard size limits. It may change only declared learnable fields. Import writes a new candidate version; it never overwrites the active version. Promotion requires schema validation, offline replay, a held-out score, regression checks for every hard invariant, and explicit acceptance. Rollback is selecting the prior immutable version.

Follow the useful `jev-align` pattern: uncertain examples plus a random audit sample, human-reviewed labels, optional rationales, immutable accepted artifacts, and no automatic promotion merely because the training score improved. Do not require the Python `jev-align` package at runtime; provide import/export compatibility at the artifact boundary.

## Component phases and remaining acceptance checks

### 0. Harden the current route

Legacy problem (addressed by the new decisions adapter): routing sees only prompt text, runs before every submitted prompt, and records requested rather than effective configuration.

Change:

1. Validate Jev settings at the JSON boundary, including complete model references, thresholds, timeouts, routes, and tool names.
2. Validate all returned probability bounds and cancellation before mutation.
3. Isolate record persistence failures from execution.
4. Record effective model, effort, and tools after Pi applies capability constraints.
5. Add decision identity and record failures with duration.
6. Replace hardcoded route instructions, criteria, and thresholds with the first validated routing policy bundle.

Exit checks: disabled mode is byte-for-byte behaviorally equivalent; abort cannot apply a route; invalid config is diagnosed; record failure cannot stop a run; offline tests cover malformed values.

### 1. Trim fresh tool output with lossless recall

Problem: large tool results dominate context. Rewriting older messages later invalidates cached prefixes and risks deleting evidence needed by future work.

Change at `tool_result` before the result becomes model-visible:

1. Skip short output, source reads, diffs, explicit requests for complete output, unresolved tool failures, and unsupported content.
2. Split eligible output on deterministic structural boundaries.
3. Protect first/last lines, failure summaries, file locations, request terms, and blocks not fully shown to Jev.
4. Ask Jev which blocks are confidently unnecessary; uncertain or failed decisions preserve the original.
5. Store the exact original in a non-model-visible session entry and expose one always-registered recall tool with line-range support.
6. Apply only when the reduction clears a configured minimum. Start disabled; enable only after replay evaluation.

Do not modify prior messages in a `context` hook. Do not paraphrase retained text.

Exit checks: exact recall after reload and branch changes; tool-call/result identity preserved; failures pass through unchanged; no prompt-cache prefix changes; real-session replay measures task success, recall use, tokens, latency, and false trims.

### 2. Route at task-phase boundaries

Problem: routing each user prompt causes unnecessary Jev calls and model/tool churn. A short follow-up such as “continue” lacks enough state to route correctly.

#### Boundary and ordering contract

Routing must finish before Pi resolves the model-facing system prompt, tool schemas, provider messages, and request payload. It must not run from `transform_context`, `before_payload`, or any hook that sees an already selected request model.

In the normal `AgentSession` path, initial routing belongs before `_preparePromptAndToolLoadout`. Routing after a tool turn belongs at the start of `_installAgentNextTurnRefresh`, before that function rebuilds the structured system-prompt sections and snapshots `model`, `thinkingLevel`, and `tools` for the next provider request.

In the durable harness, `before_generation` already runs before model lookup, tool resolution, `resolveSystemPrompt`, `before_request`, `transform_context`, and payload construction. Keep that ordering and persist the resulting configuration before provider admission so retries reuse it rather than rerouting.

The default policy supplies finite phases `investigate`, `implement`, `verify`, and `synthesize`, but their descriptions and permitted transitions live in the routing policy bundle so they can be evaluated and improved. Code admits only a configured transition and does so only after settled tool results or a new task. A transition permits, but does not require, a route decision. Transport retry, compaction, queue delivery, and an additional tool result do not themselves create a phase transition.

#### Private routing snapshot

Build a typed routing snapshot directly from harness state. It is sent to the selected decision implementation and is not inserted into the main model's prompt or default telemetry. Exact learning/replay capture requires a separate opt-in dataset. Bound every collection and refer to large values by safe summaries or IDs.

The snapshot contains:

- session branch, run, generation, and admitted phase identity;
- active task and explicit user constraints;
- recent structured outcomes: tool name, success/failure, error category, duration, and bounded result summary;
- unresolved tool calls, pending messages, cancellation state, retry count, and compaction/context pressure;
- current model, reasoning effort, tool profile, and their observed usage and latency in this phase;
- recent applied and rejected routing decisions with fallback reasons;
- eligible model–effort pairs, capability metadata, authentication/availability, configured price data, and context limits;
- prompt-cache facts available from provider usage: stable-prefix identity, cache reads/writes, estimated reusable tokens, and whether changing model, effort, tool schemas, or system-prompt sections invalidates that prefix;
- remaining phase budget and explicit user cost/latency preferences.

Do not send secrets, raw environment values, full repository content, or full tool output. The router receives state that the main model does not need to see, but it does not receive unrestricted process state.

#### Candidate and switching contract

Generate the candidate set in TypeScript as complete `(provider, model, reasoning effort, tool profile)` records. Filter unavailable, unauthenticated, over-budget, context-incompatible, and unsupported-effort pairs before the Jev call. Jev returns one opaque candidate ID or `keep_current`; it never returns a free-form model name or effort.

Implemented smaller-window admission, when context management is enabled, uses a conservative pre-render floor. After routing, `context_management` prepares raw history/current user input with a private prompt-overhead estimate, checks structure and estimated total budget, then builds the prompt. No postconstruction gate or second ordinary semantic call runs. Summary fallback allows one fresh preparation before building; residual estimate/render overflow uses provider recovery. This is heuristic admission, not a full-request fit guarantee.

Context `cacheAware: true` defaults to stable-plan reuse and an optional cost preference for a still-fitting previous view under same-plan soft pressure. False rejudges each preparation and bypasses reuse/cost preference. Configure horizon/margin with `cacheExpectedRequests` (3) and `cacheMinSavingsUsd` (0). Changed task/phase/configuration/failure state, hard pressure, manual compaction and overflow bypass the preference; unknown economics allow relevant selection. See [ADR 4](adr/0004-context-window-management.md) for rate/prefix assumptions and tokenizer/summarizer limits. Historical tools and existing skills/retrieval are selectable; arbitrary optional prompt material is not.

Separate semantic fit from deterministic cost. Jev ranks task fit using the private snapshot. TypeScript calculates switching cost from pricing and observed usage:

`future cost = decision overhead + first-request uncached/cache-write/cache-read cost + remaining-phase input/output cost`

Compute this for staying and for each candidate, without counting invalidated cache tokens twice. Prior spend is sunk cost. A cost-driven switch requires the difference to clear the uncertainty margin.

Compare that with the expected cost of finishing the phase on the current pair, using a conservative uncertainty margin. Treat cross-model cache reuse as zero unless the provider reports otherwise. Treat changes to reasoning effort, tool definitions/order, or stable system-prompt sections as cache-invalidating when the provider's cache contract says so. Unknown pricing or cache state retains the current pair for cost-driven switches; a capability-driven escalation may override that only within an explicit budget.

Pin model, effort, tool definitions/order, and stable prompt sections for the phase. Reconsider them only when code admits the next phase or the current candidate becomes unavailable. Explicit user model or effort changes create a recorded override and establish the new current pair; they are not silently undone by routing.

Persist the applied phase decision on the session branch and reuse it across retry, reload, and unchanged phases.

Exit checks: routing completes before prompt/tool/payload construction; private harness-only fields never enter the main-model prompt or default trace; no reroute within a phase; no tool-order churn; one admitted route per transition; retry and restart reuse the decision; unsupported model–effort pairs never reach Jev; unknown cost retains current configuration; cache loss can reject an otherwise cheaper route; explicit user overrides win.

### 3. Select skills and tools from bounded rosters

At the same admitted phase boundary:

- collect loaded skill IDs and descriptions;
- mark explicitly requested skills as required;
- offer named complete tool profiles rather than arbitrary tool subsets;
- let the configured implementation select a subset of eligible loaded skills and a complete routing/tool-profile candidate;
- apply phase-pinned skill visibility through `preparePhase` before prompt assembly and routing costs; retain existing skill expansion and active-tool mechanisms.

Do not automatically install skills or extensions. Do not allow Jev to generate paths, commands, tool names, or skill names.

Exit checks: explicit skills always load; required tools remain active; failure preserves default selection; stable candidate order yields stable records.

### 4. Rank retrieved context

The implemented `retrieval.rank/v1` component runs on fresh settled built-in `grep`/`find` output. It groups hits, retains deterministic required groups, skips truncated or unsupported results, and stores exact originals for recall before reducing output. It does not rewrite existing history.

Custom retrieval systems use `selectRetrievedContext` with caller-supplied candidates, dependency groups, required markers and token counts. Over-budget selections return the unchanged fallback; the caller must compact or defer if that still does not fit. This is an intentional source-specific API boundary. Selected excerpts guide focused reads; they are not sufficient evidence for a final factual claim.

Exit checks: required groups cannot be omitted; prior stored transcript is unchanged and reduced fresh output has exact recall; truncated search results pass through; failure returns every candidate; evaluation compares whole-session cost and answer quality, not only returned bytes.

### 5. Verify completion and evidence

Reuse `agent_end`/`before_run_end`. Supply the active task criteria, claimed completion, actual check results, unresolved failures, pending user input, and a small bounded evidence set.

Allowed outcomes are `accept`, `verify`, and `clarify`. Code supplies the corresponding fixed follow-up, limits additional passes, and gives pending user input and deterministic failed checks precedence. A separate source-evidence classifier may return `supports`, `contradicts`, or `insufficient`; it must not invent citations.

Exit checks: no infinite continuation; failed tests cannot be semantically accepted; pending user input wins; unsupported claims trigger a bounded verification step.

### 6. Optional tool-call review

Only after the earlier components have measurements, add an opt-in uncertain-action review:

1. Deterministic validation and sandbox policy decide known allow/deny cases.
2. Jev classifies only the gray zone as `proceed`, `request_review`, or `block`.
3. `proceed` means the semantic policy found no objection; it never grants permissions.
4. Missing keys, timeout behavior, and headless behavior are explicit configuration choices, with conservative defaults for destructive actions.

Keep this separate from routing and quality review so a failure cannot disable unrelated protections.

## Deferred work

- Arbitrary user/assistant-text pruning: remains outside the limited tool-history provider projection and requires convincing real-session evidence.
- Autonomous tool-using specialist trees: remain deferred. Bounded tool-requested, single-call consultations with an approved roster and budgets are implemented.
- Prompt grading or rewriting: useful as a user-facing extension, not a core harness responsibility.
- Multi-model deliberation: remains an extension; it is not required for bounded harness decisions.
- Automatic extension installation: Jev selection does not establish trust in third-party code.

## Evaluation gate

Each phase ships behind an independent setting and an offline replay corpus. Live enablement requires:

- no regression in task completion or required-evidence retention;
- measured whole-session token/cost change, including Jev and cache writes;
- p50/p95 decision latency and failure rate;
- false-application rate, recall frequency, and fallback frequency;
- deterministic replay from recorded decisions;
- explicit removal criteria when the component fails to beat ordinary Pi behavior.

Synthetic fixtures establish correctness, not usefulness. Promotion from disabled to opt-in requires replaying real redacted sessions; promotion beyond opt-in requires held-out task results.

## Source corpus

The review checkout is temporary and not vendored. The principal implementations were:

- General clients and suites: [DevMortimer/pi-typesafe](https://github.com/DevMortimer/pi-typesafe), [TheoOliveira/pi-jev](https://github.com/TheoOliveira/pi-jev), [y0usaf/pi-jev](https://github.com/y0usaf/pi-jev), [iefnaf/pi-jev](https://github.com/iefnaf/pi-jev), [MoonTory/pi-jev-harness](https://github.com/MoonTory/pi-jev-harness), [madeye/pi-jev](https://github.com/madeye/pi-jev), [Jabbslad/pi-jev-tools](https://github.com/Jabbslad/pi-jev-tools).
- Routing and orchestration: [da-vinci-noob/pi-jev-model-router](https://github.com/da-vinci-noob/pi-jev-model-router), [rizafahmi/pi-jev-task-router](https://github.com/rizafahmi/pi-jev-task-router), [nijaru/pi-router](https://github.com/nijaru/pi-router), [willgriffin/pi-fusion-matrix](https://github.com/willgriffin/pi-fusion-matrix), [onlyjq04/jev-agent-hooks](https://github.com/onlyjq04/jev-agent-hooks).
- Context and compaction: [Nyarlathoteppppp/pi-jev-context](https://github.com/Nyarlathoteppppp/pi-jev-context), [QuentinDanblon/pi-fast-jev-compaction](https://github.com/QuentinDanblon/pi-fast-jev-compaction), [Shashank-H/pi-jev-context-curator](https://github.com/Shashank-H/pi-jev-context-curator), [vava-nessa/pi-jev-compaction](https://github.com/vava-nessa/pi-jev-compaction), [Wang-auspicious/pi-jev-compaction](https://github.com/Wang-auspicious/pi-jev-compaction).
- Guards and review: [jomatsu/pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode), [DevMortimer/pi-warden](https://github.com/DevMortimer/pi-warden), [dys-org/pi-jev-gate](https://github.com/dys-org/pi-jev-gate), [jesset/pi-verdict](https://github.com/jesset/pi-verdict), [TannerMidd/specpi-jev-guard](https://github.com/TannerMidd/specpi-jev-guard), [AbdelStark/bicameral](https://github.com/AbdelStark/bicameral), [KamilPostrozny/pi-jev-code](https://github.com/KamilPostrozny/pi-jev-code), [zephyrdeng/pi-review](https://github.com/zephyrdeng/pi-review), [irfndi/oh-my-plumb](https://github.com/irfndi/oh-my-plumb).
- Other focused extensions: [HikaruEgashira/pi-prompt-enhancer](https://github.com/HikaruEgashira/pi-prompt-enhancer), [rezamonangg/pi-intentgate-jev](https://github.com/rezamonangg/pi-intentgate-jev), [BubbatheVTOG/pi-jev-redact](https://github.com/BubbatheVTOG/pi-jev-redact).
- Learning and portable function artifacts: [sutro-sh/jev-align](https://github.com/sutro-sh/jev-align).

`gloridifice/pi-jev-router` appeared in a search index but was not publicly cloneable during this review, so it was not used as implementation evidence.
