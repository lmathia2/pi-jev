# ADR 4: Recoverable context selection before generation

Status: accepted. Date: 2026-09-20.

## Problem

A summary can lose an exact command or error. Deleting source history makes later task changes irreversible. Selection alone is also insufficient: a small history can overflow once system text, tools and output reservation are included.

For example, an old successful search can leave the model view during implementation. If the user later asks about that search, a new plan can restore its original result; `recall_context` can also retrieve it explicitly. If protected dialogue alone exceeds capacity, removing more tool results cannot solve the problem.

## Decision

Use the existing registry with `context.retention/v1` score answers. Two independent candidates describe each eligible tool call and result. The Jev adapter returns raw probabilities using its existing batched transport; implementations remain swappable and comparable. Instructions and criteria live in versioned policy files. Thresholds, projection sizes, concurrency and reduction targets live in validated component configuration. Learning may tune these values, but cannot remove host safety checks.

Preserve source session entries. Persist only branch-local selection plans, item digests, scores and invocation metadata. Apply keep, exact head/tail excerpt or complete-pair omission to a model-facing copy. Missing/invalid judgments retain evidence. Preserve narrative, errors, multimodal results, first-message calls, configured recent messages and recall results. An excerpt is explicitly marked, never presented as complete output. No result may lose its call.

The classifier receives an ordered, bounded overview of the conversation, actual candidate excerpts and private harness state. It does not inspect all result contents: bounded excerpts can miss relevant evidence. Unknown judgments stay, and evaluation must measure evidence loss rather than assume classification is correct.

`cacheAware` defaults to true. Reuse plans while task/phase/model/effort/tool/failure identity is stable and estimated capacity permits. Changed identities re-evaluate original history. Digest checks prevent applying decisions to changed evidence. Pressure, manual compaction and overflow also trigger planning.

Routing remains before prompt construction. `before_generation` chooses configuration, then `context_management` prepares from raw history/current user input plus private `promptOverheadTokens`. Structural checks and estimated total-budget admission occur in this preparation; only then is the prompt built. A conservative pre-render floor makes smaller-window routes eligible. There is no postconstruction semantic call or admission gate. The output reservation is at least the configured host reserve and model maximum output; the component may add a larger reserve and margin. Estimate/render mismatches rely on existing provider overflow recovery.

Selection-first behavior applies to dispatch, manual compaction and overflow recovery using the same raw-source planner. Successful manual selection returns `strategy: "selection"` without adding a summary entry. When selection cannot meet the estimated budget, use existing summarization once, prepare again after the summary, then build the prompt if the estimate fits. Cancellation or stale proposals cannot be applied.

### With and without cache awareness

With `cacheAware: true`, a stable task and plan below trigger pressure reuse the existing view without scoring. Under same-plan soft pressure, scoring may propose a smaller view. If the old view still fits the estimated hard budget, a deterministic cost comparison can retain it when projected savings do not exceed `cacheMinSavingsUsd` (default 0). `cacheExpectedRequests` (default 3) sets the horizon. Already-spent classifier work is not recovered by rejecting its proposal.

For example: stable phase → old view fits → new trimming would invalidate an expensive prefix → estimated savings fall below the margin → keep the prior plan. A changed task/phase/configuration/failure, manual request, overflow or hard-budget pressure bypasses this preference so cache economics cannot prevent required replanning.

With `cacheAware: false`, every preparation rejudges original evidence regardless of trigger pressure. It neither reuses the prior plan nor applies the cost preference. For example: unchanged task → fresh call/result scores → admit relevant reduction by structural and estimated-budget rules → build prompt. This may spend more on decisions and change the prefix more often, but does not weaken protected evidence, pairing, recall, cancellation or budget checks.

The cost estimate requires valid registry rates and the latest same-model assistant cache-read usage. It compares the old cached input with a new estimated common prefix across the configured horizon; cold tokens use the greater of input/cache-write rates, and warm tokens use cache-read rates or input rates when zero. Unknown economics allow the relevant proposal. Common-prefix estimates and observed cache reads do not guarantee future provider hits.

Expose bounded, branch-local `recall_context`: omit the ID to discover original result IDs; supply an ID and character offset to retrieve text. Prefer saved original output where fresh-output selection already reduced it. Existing sessions remain recoverable after disabling inference. No second storage, search service or plugin runtime is introduced.

## Limits and consequences

- Selection is threshold-based, not a combinatorial optimizer. The target ratio is soft; estimated generation input capacity is the enforced ceiling.
- Dynamic selection covers historical tool interactions and existing skill/retrieval integrations, not every optional system-prompt material.
- Token accounting uses a serialized-size heuristic plus estimated prompt/tool overhead, not a provider tokenizer. No post-render check guarantees the assembled request fits; calibrate estimates against actual usage, especially for multimodal content.
- Known queued input participates in preparation. Steering input arriving during preparation stays intact under Pi's existing delivery rules, but is outside that earlier estimate. Trusted context/payload extensions can also change the final request; provider overflow recovery handles these mismatches.
- The legacy summarizer's own provider request is not bounded by this preparation. Extreme histories can still fail in summarization; they are not silently discarded.
- Narrative remains verbatim during selection, but ordinary fallback summarization remains lossy. Original session records remain local; the active context still respects prior summary entries.
- Scoring sends bounded task/tool content to the configured implementation. Length bounds are not redaction. Offline capture/export still requires separate consent and redaction.
- Tests use fake providers and compact lifecycle traces. Real evidence retention, total cost, cache behavior and learned-policy quality remain experiments.

Implementation: [planner](../../packages/coding-agent/src/jev/decision-context.ts), [admission](../../packages/coding-agent/src/core/context-budget.ts), [recall](../../packages/coding-agent/src/jev/context-recall.ts).
