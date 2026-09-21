# Reusable decision library and policy plugins

Status: reusable library and opt-in harness adapters implemented; broader acceptance requirements remain tracked below. This document supersedes the shared-library, comparison, learning, and plugin architecture in [the roadmap](jev-integration-roadmap.md). See the [implementation log](jev-implementation-log.md) for delivered changes and [experiment queue](jev-experiments.md) for measurements still to run.

## Implementation status

| Area | Implemented | Remaining work |
|---|---|---|
| Reusable contracts | [Decision package](../packages/decisions/src/index.ts), registry, validated finite answers, isolated inputs, timeout/cancellation, invocation budget, baseline/heuristic/recorded/Jev implementations | Provider-level token/concurrency budgets and measured cost attribution across every transport |
| Policy plugins | Data-only manifests, strict artifact metadata, atomic `PolicyStore` activation, injected executable implementations, configured definition bindings; optional `policyDigests` pins enforce immutable `id@version` content across restarts | Automatic filesystem reload; reviewed optimizer search spaces for real experiments |
| Normal routing | [Routing adapter](../packages/coding-agent/src/jev/decision-routing.ts), complete model/effort/tool candidates, branch-local decisions, pre-prompt generation hook, explicit phase command/callback, optional `generation.phase/v1` classification, deterministic cache-cost admission; context-enabled smaller-window admission uses a conservative pre-render floor and estimated preparation budget | Calibrate phase judgments, overhead estimates and transition descriptions on real tasks; provider-specific cache-survival calibration |
| Durable routing | [Generation adapter](../packages/coding-agent/src/jev/decision-durable.ts), injected private snapshots/admission, complete configuration checkpoint before provider request, retry reuse, chosen configuration passed to prompt callback | Host-owned phase/policy identity, roster and admission are intentional API boundaries; the normal CLI uses its own adapter |
| Offline comparison | [Paired runner](../packages/decisions/src/evaluation.ts), common admission callback, isolated requests, labeled agreement, failures, latency/cost summaries, task-group split validation | Complete-task counterfactual trials and production challenger experiments |
| Learning | [JSONL capture/export and jev-align bridge](../packages/decisions/src/learning.ts), bounded numeric calibration, new candidate artifacts, heldout promotion gates and rollback pointers | Real redacted datasets, reviewed delayed outcomes, GEPA execution, report attestation and live activation wiring |
| Tool-history context | [Context planner](../packages/coding-agent/src/jev/decision-context.ts), shared preconstruction `context_management` for dispatch/manual/overflow, call/result scores, recoverable projection, summary fallback, estimated admission and configurable cache preference | Real-task retention quality and cache-loss measurements; no arbitrary user/assistant-text pruning or post-render fit guarantee |
| Other decisions | [Component adapters](../packages/coding-agent/src/jev/decision-components.ts) for fresh-output retention/recall, grouped built-in `grep`/`find` results, advisory tool review and bounded completion; [phase-pinned loaded-skill selection](../packages/coding-agent/src/jev/decision-selection.ts) before prompt assembly and routing costs | Real-task recall/quality measurements; research-evidence classifier, semantic recovery and specialist dispatch |

The remaining sections preserve the intended contracts and acceptance criteria. They are requirements, not a claim that every host integration or experiment is complete. Components remain opt-in; no paid optimizer or provider experiment was run during implementation.

Skill selection uses the full loaded roster, preserves explicit requests and runs through routing's `preparePhase` before the prompt is built. It changes skill visibility, not installation. Retrieval selection operates only on fresh settled built-in `grep`/`find` output, retains required/dependent groups and exact originals for recall, and skips truncated results. Custom retrieval systems use the injected candidate/token-budget API; neither path rewrites older transcript messages. The full repository check remains blocked by existing AI model-catalogue errors; focused checks do not establish production readiness.

Normal phase classification is configured with `phaseBinding`, `transitions`, `phaseDescriptions` and `maxPhaseDecisions`. It runs only on a noninitial generation boundary with a newly settled tool result, uses an independent budget, and records that result's check so it is not repeated. Choosing the current phase means stay; it does not trigger model rerouting. An allowed transition is persisted before routing. Explicit host phase callbacks take precedence over the classifier. This does not supply durable-host phase state automatically.

## Original review findings

1. The current plan keeps the library under `coding-agent/src/jev`. Its public helpers accept `TypeSafeClient`, and its result types expose SDK `Usage`. Another harness or a deterministic implementation cannot reuse that contract without importing Jev-specific types. Extract a small independent decision package and isolate the Jev adapter.
2. `GenerationRouteProvider.decide(task, signal)` hides the candidate set, policy revision, and private state. Different implementations could construct different problems and produce incomparable scores. Define one immutable decision request before dispatching to any implementation.
3. The plan has no contract for evaluation against alternative implementations. Separate proposal generation from application so a comparison runner can evaluate several proposals while the harness applies exactly one.
4. The proposed switch-cost formula adds cold prompt cost and lost-cache value, potentially charging for the same invalidation twice. Compare complete expected future costs for staying and switching; prior spend is sunk cost.
5. Training metrics, promotion thresholds, and enablement are listed beside learnable parameters. An optimizer must not change its own acceptance test, spending cap, enabled components, or data-access scope. Separate policy search space from operator and evaluator configuration.
6. A metadata-only trace cannot reproduce semantic inputs. Exact replay requires separately consented input capture with its own retention rules; otherwise mark examples non-replayable.
7. The existing removed shadow runtime must not return implicitly. Comparison starts as an explicit offline evaluation command. Production evaluation of challengers requires a separate opt-in experiment.

## Ownership and dependencies

Implemented workspace package: `packages/decisions`, named `@earendil-works/pi-decisions`. Publication remains a separate action.

| Layer | Owns | Does not import |
|---|---|---|
| `pi-decisions` core | JSON contracts, implementation registration, invocation limits, result validation, policy loading | Coding agent, agent session, UI, Chord, Jev SDK |
| `pi-decisions/jev` adapter | Jev request construction and response normalization | Coding agent or UI |
| Coding-agent adapters | State extraction, candidate construction, admission, fallback, persistence, action application | Optimizers |
| Decision evaluation entry point | Paired fixtures/replay, grouped splits and numeric calibration; existing eval harness remains available for complete-task trials | Interactive UI |
| Offline optimizer bridge | Dataset export and accepted artifact import | Live session mutation |

Keep the Jev SDK behind its adapter entry point. Resolve dependency packaging during implementation using existing workspace conventions; importing the core must neither load the SDK nor read credentials. Credentials and transport are injected when constructing an adapter.

Start with ordinary functions, an implementation registry, and a validated JSON artifact. The current CLI can use these directly. Chord hosts can expose the same registry as a service using existing facets; core does not require a second plugin runtime.

## Four separate contracts

**Decision definition.** A versioned, host-owned contract such as `generation.phase/v1`, `generation.route/v1`, `tools.profile/v1`, `tools.review/v1`, or `context.select/v1`. It specifies input/output schemas, candidate semantics, required features, and validation. Definitions describe the question; they do not execute actions.

**Implementation.** A registered function that proposes an answer for a supported definition. Initial implementations are `baseline.keep-current`, a deterministic routing heuristic, `jev.typed`, and a recorded-response fixture. Later LLM or learned local predictors implement the same contract. Implementations declare supported definitions and configuration schema.

**Policy artifact.** Versioned data used by an implementation: question instructions, criteria, thresholds, feature selections from an approved list, and supported algorithm parameters. Two instances of `jev.typed` with different artifact hashes are separate comparison variants.

**Harness adapter.** Captures state, enumerates authorized candidates, invokes the selected implementation, validates freshness and feasibility, persists the effective decision, and applies it at the correct lifecycle boundary. Only this layer changes model, effort, tools, context, or continuation.

An implementation receives data and an abort signal, never `ExtensionAPI`, `AgentSession`, or tool execution handles. This is an API separation, not a sandbox: trusted JavaScript plugins still execute with process permissions.

## Minimal API shape

Core contract shape; [contracts.ts](../packages/decisions/src/contracts.ts) is authoritative and also includes usage metadata and optional implementation policy validation:

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Candidate {
  id: string;
  description: string;
  attributes: Readonly<Record<string, Json>>;
}

interface DecisionRequest {
  definition: string;
  boundaryId: string;
  stateRevision: string;
  features: Readonly<Record<string, Json>>;
  candidates: readonly Candidate[];
  currentCandidateId?: string;
}

type DecisionAnswer =
  | { kind: "select"; candidateId: string }
  | { kind: "subset"; candidateIds: readonly string[] }
  | { kind: "score"; values: Readonly<Record<string, number>> };

type DecisionResult =
  | { status: "proposed"; answer: DecisionAnswer; evidence?: Json }
  | { status: "abstained"; reason: string }
  | { status: "failed"; reason: string };

interface DecisionImplementation {
  id: string;
  version: string;
  definitions: readonly string[];
  evaluate(
    request: DecisionRequest,
    policy: Readonly<Record<string, Json>>,
    signal: AbortSignal,
  ): Promise<DecisionResult>;
}
```

Definition-specific schemas narrow these shapes. Routing accepts only `select`; context selection accepts `subset`; unknown or duplicate IDs are rejected. Probability and score evidence carries its scale and calibration version. A heuristic is not required to fabricate probabilities, and raw confidence numbers from different implementations are never assumed comparable.

`context.retention/v1` accepts a complete `score` map in `[0,1]` for evidence candidates named `${toolId}:call` and `${toolId}:result`. The Jev adapter batches independent Noul judgments against shared bounded state; it does not threshold them. Configurable host thresholds choose keep, exact excerpt, or paired omission. `baseline.keep-current` returns all-one retention scores with zero remote requests. The planner preserves all user and assistant text, changes only eligible complete tool interactions in the provider view, and leaves stored originals available through recall discovery. Dispatch, manual compaction and overflow share preconstruction selection and estimated-budget admission; insufficient reduction falls back to existing summaries. There is no post-render gate or exact fit guarantee.

The invocation wrapper records implementation version, policy digest, canonical input/candidate digest, elapsed time, request count, provider-reported usage, and cost when known. Normalize known adapter failures into stable codes. Unknown cost is distinct from zero. Deep-freeze or independently clone validated requests for comparisons; TypeScript `readonly` alone does not prevent mutation.

For Jev, questions within a batch are independent. A check of the selected candidate must receive that actual candidate in a subsequent request, or assess each candidate independently. Do not ask a concurrent question to inspect another question's answer.

## Boundary flow and private state

At an eligible generation boundary:

1. Capture a revisioned private harness snapshot and determine whether a phase transition is eligible.
2. Resolve the active immutable policy version and build eligible model–effort candidates from the operator's roster.
3. Run phase/profile/skill selection as required, composing the prospective configuration before costing it. Tool selection must not invalidate a cache assumption after routing has been priced.
4. Ask the configured routing implementation for a proposal using the snapshot and candidate descriptors.
5. Validate the proposal, cache economics, budget, cancellation, user overrides, and state revision. Stale proposals cannot mutate the session.
6. Persist the admitted configuration and its identity using the host's normal state mechanism.
7. Prepare context selection from raw history/current user input plus private `promptOverheadTokens`, and validate structure and estimated total budget. If necessary, summarize once and prepare again after the summary. Only then assemble the prompt/tool schemas and issue the request. There is no postconstruction admission or second ordinary semantic call; residual estimate/render overflow uses existing provider recovery.

Cost estimates before prompt assembly use existing structured sections, tool definitions, prior token counts, and conservative estimators. They cannot depend on generating the final target prompt first. Selected configuration must be explicitly available to the prompt builder; merely changing a local routing variable is insufficient.

At tool review, capture a fresh snapshot after argument validation and before execution: proposed call, relevant task constraints, prior failures, pending input, active phase, approvals, and effects metadata. At output selection, include the settled result and retention constraints. Each decision receives only its approved state projection, with authority facts distinguished from untrusted content.

Snapshot fields need not appear in the main-model prompt. Default traces contain identifiers and aggregate measurements only. Semantic input capture is a separate opt-in local dataset, with redaction before both evaluation and capture if exact replay is required. Digests cannot reconstruct omitted text.

## Cache-aware model and effort selection

Context selection has a separate cache preference described in [ADR 4](adr/0004-context-window-management.md). `cacheAware: true` (default) reuses stable plans and may retain a still-fitting previous view when same-plan soft-pressure trimming does not clear estimated savings. `cacheExpectedRequests: 3` and `cacheMinSavingsUsd: 0` set horizon/margin. False rejudges every preparation without reuse or cost preference. Changed task/phase/configuration/failure state, hard pressure, manual compaction and overflow bypass cache preference; unknown economics allow relevant selection. This does not weaken structural/estimated-budget checks or dynamically select every optional prompt material.

Operator configuration lists models and supported/configured efforts. The host builds finite candidate IDs and passes them to implementations. Four fixed labels such as `fast` and `deep` may be preset descriptions, but cannot be the public output contract.

For each eligible candidate, estimate:

`future cost = decision overhead + first-request uncached/cache-write/cache-read cost + remaining-phase input/output cost`

Use provider-specific rates and cache assumptions without counting any token twice. Switch for economy only when `future_cost(stay) - future_cost(candidate)` exceeds the configured uncertainty margin and quality constraints are met. Sunk costs are excluded. Capability escalation is separately recorded and bounded by operator limits.

The learner may estimate remaining work, cache survival, or expected quality within declared parameter bounds. Actual tariffs, supported efforts, credentials, model allowlists, and maximum spend remain operator/runtime facts. Unknown economics cannot establish savings.

A decision is pinned to its phase and policy version. A policy reload takes effect at the next eligible boundary. User overrides, cancellation, and unavailable providers require explicit handling and do not allow repeated semantic rerouting on every retry.

## Plugin configuration

Use existing Pi package/extension loading for trusted executable implementations. Add a typed registration surface for decision implementations; reject duplicate IDs and incompatible definition versions. Registration makes an implementation available; configuration selects it. No separate installer or arbitrary module import from JSON is needed.

Data-only policy plugins are directories containing a JSON manifest and policy files, loaded by the decision library from configured paths. They require no executable extension. Policies expose no shell commands, JavaScript expressions, or arbitrary property access into harness objects.

The implemented configuration selects policies directly by definition. For example, an explicitly enabled review component uses a data-only policy package:

```json
{
  "jev": {
    "mode": "decisions",
    "decisions": {
      "policyPackages": ["./policies/team"],
      "policyReferences": { "tools.review/v1": "team/review@1" },
      "components": { "review": { "tools": ["bash"], "onFailure": "block" } }
    }
  }
}
```

The package must actually contain the referenced policy. Routing additionally requires the complete `routing` configuration in [DecisionSettings](../packages/coding-agent/src/jev/decision-runtime.ts). Executable variants are injected through `implementations`; offline comparison variants are passed to `compareImplementations`. There is no second installer or `instances` configuration layer.

For reproducibility across restarts, set `policyDigests` to a map from each referenced `id@version` to its reviewed SHA-256 artifact digest. Pins are optional; without them, the store prevents version mutation only within that process. A mismatched pinned artifact rejects activation. Semantic instructions and tunable parameters remain policy/configuration data; runtime invariants and operator release gates are not optimizer-editable.

Resolve settings through existing trusted project/global precedence. Resolve each policy reference to a content digest and validate the entire candidate configuration before activation. Reject invalid updates while retaining the last valid configuration; on first startup use the definition's host fallback and report the error. Never partially apply a bundle. Revalidate authorization and availability before reuse after restart.

Policy metadata declares definition/version, input projection version, implementation compatibility, questions, parameters, and provenance. Operator-owned search-space configuration declares which fields optimizers may edit, numeric bounds, approved features, and budgets. Hard limits and acceptance tests are outside the candidate artifact.

## Comparing implementations

Start with offline paired evaluation: same dataset split, state, ordered candidates, contract, and feature projection for every variant. Differences in inputs or feature projections are explicit experiments. Separate recorded replay (reproducibility) from fresh inference (stochastic performance); report repetitions and resolved Jev model version.

The comparison runner validates every proposal through the same admission rules but executes no real tools. Record abstentions, invalid results, fallbacks, latency, usage, correctness, and policy-specific errors. A disabled baseline keeps the current configuration and makes no API requests.

Decision replay can measure agreement with labels; it cannot establish which unchosen model would have completed the task better. Routing benefit requires controlled complete-task runs across variants with isolated workspaces and equal budgets. Never assign the production winner's observed result to a challenger that only proposed a different action.

An optional later production comparison mode evaluates challengers on the same captured snapshot under separate budgets and deadlines. Only the active implementation may affect execution. Challenger failures cannot delay the primary path or enqueue follow-ups. This is separately enabled, not a restoration of the removed global shadow setting.

## Learning and promotion

The inspected `jev-align` implementation optimizes text instructions and fixed Choice/Noul/Score criteria through GEPA. Its stock task schemas do not optimize arbitrary numeric weights, dynamic routing rosters, or harness workflows automatically. Provide an explicit conversion adapter; use a calibration sweep or another optimizer for numeric parameters through the same artifact format.

For dynamic model rosters, use a custom evaluator that renders the row's candidate descriptors and validates the returned ID. An alternative is to optimize fixed rubric judgments and compose their scores in code. Do not train fixed provider/model labels and assume they generalize to a new roster.

Pipeline: consented examples and delayed outcomes → reviewed labels/rationales → train/development split → optimizer candidate → numeric calibration → frozen held-out evaluation → accepted policy version.

Split by task/session and, where possible, repository/time so correlated turns do not leak across splits. Keep the final holdout out of optimization and reflective feedback. Record uncertain-example acquisition probabilities plus random audit samples. User overrides are feedback, not automatically ground truth; missing outcomes are not successes.

Use component-specific objectives: retention recall for context; false approvals and false blocks for review; verified task completion under cost/latency limits for routing. The evaluator and release gates are operator-owned. Optimize one component first; evaluate the composed harness before promoting several interacting policies.

Activation and rollback select immutable policy digests at a boundary. Persist the digest with every effective decision. Phase IDs and output semantics remain fixed during an optimization experiment; changes require a new contract version and explicit state migration. Feature selection can vary only within the approved projection and cannot omit required policy facts.

## Delivery sequence and acceptance

1. Extract the independent contracts and registry; implement keep-current, deterministic heuristic, recorded fixture, and Jev adapters. Test all against the same conformance suite.
2. Add policy manifests, schema validation, version pinning, trusted configuration, and atomic activation. Demonstrate that JSON edits change behavior without rebuilding core.
3. Wire stateful routing before prompt construction in the normal CLI, with phase identity, joint model/effort selection, cache economics, cancellation, and actual configuration persistence. Add a separate durable-harness adapter sharing the decision library; do not claim identical crash guarantees for the two hosts.
4. Add paired offline comparison and opt-in input capture. Verify that only the selected implementation can apply a proposal.
5. Add `jev-align` artifact conversion and a numeric calibration evaluator; demonstrate export → candidate → held-out report → activate → rollback using fake transports and fixtures.
6. Apply the same contracts to fresh output selection and tool review, then skills, retrieval, and completion as described in the roadmap.

Required tests include zero Jev calls when disabled, identical snapshots across variants, invalid plugin results, policy update failure, stale snapshots, abort-before-apply, prompt assembly ordering, unsupported efforts, cache break-even arithmetic, phase pinning, branch/restart behavior, outcome attribution, and training/holdout separation. Use existing tests and the faux provider; live paid training remains explicitly invoked.

The implemented foundation supports multiple implementations, config-only policy changes, comparable offline results and learned artifact conversion. The [experiment queue](jev-experiments.md) covers the real-data and complete-task evidence needed to establish routing benefit, followed by composed-component evaluation.
