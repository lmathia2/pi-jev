# Jev integration plan

Status: implementation plan

Product branch: `main`

Reference prototype: `prototype`

## 1. Purpose

`pi-jev` is an independent agent harness derived from Pi. It will preserve Pi's execution quality—durable operations, explicit effects, reliable tool handling, session trees, compaction, and extension support—while using Jev for fast, typed semantic decisions inside the harness.

Jev does not replace the agent model or the harness. Pi remains responsible for generating text, executing tools, enforcing policy, persisting state, and recovering operations. Jev answers bounded semantic questions whose outputs can be validated and applied by deterministic code.

The first implementation must prove that Jev improves routing, context use, or loop efficiency without regressing task completion. We will add one integration seam at a time and retain Pi's current behavior as the fallback.

## 2. Goals

1. Route turns to the appropriate model, thinking level, visible tools, and skills before generation.
2. Reduce irrelevant context using retrieval followed by Jev ranking and verification.
3. Make loop checkpoints capable of choosing continue, verify, clarify, delegate, retry, or finish.
4. Reduce context growth by retaining useful tool interactions and dropping low-value ones without breaking tool-call/result structure.
5. Select coding and research specialists using the same bounded decision mechanism.
6. Measure every enabled decision against unmodified Pi behavior.
7. Keep sessions recoverable and deterministic at every durable boundary.

## 3. Non-goals

- Jev will not generate user-facing prose, code, summaries, search queries, or tool arguments containing open-ended values.
- Jev will not execute tools or grant authority.
- Jev will not be the sole security boundary for prompt injection, destructive tools, secrets, or external side effects.
- The first releases will not add a generic decision framework, a native subagent runtime, a task graph, or a replacement context store.
- Ongoing synchronization with upstream Pi is not required. Compatibility with Jev disabled is still a regression oracle, not a product constraint.

## 4. Current Pi contracts we must preserve

### 4.1 Durable execution

`packages/agent` owns the durable operation state machine. A run moves through durable request, provider, retry, tool, deferred, and terminal states. External effects pass through the effect gate so recovery can distinguish an effect that never started from one whose outcome is unknown.

Jev calls that affect execution must obey the same rules:

- cancellation uses the invocation `Context`;
- a decision is captured for the operation boundary at which it applies;
- recovery never silently makes a different decision for an already admitted effect;
- abort reconciliation starts no new Jev work;
- a Jev failure is an in-band fallback unless storage itself fails.

### 4.2 Generation boundary

Pi currently snapshots lane configuration—model identity, thinking level, and active tools—when preparing generation. Existing hooks can transform messages and request options, but there is no single durable hook that selects all three immediately before the snapshot.

This makes pre-generation routing the first justified core seam. The seam must remain provider-neutral: `packages/agent` exposes the boundary; `packages/coding-agent` supplies the Jev policy.

### 4.3 Tool execution

Tools already have stable logical invocation IDs, durable memos for replay-safe work, sequential or parallel execution, partial-result checkpoints, and synthetic errors. Jev may recommend which tools are visible or assess a proposed call, but deterministic code remains authoritative.

### 4.4 Context and compaction

Pi reconstructs provider context from the newest compaction summary plus its retained tail. Compaction cuts only at valid boundaries and preserves tool results with their calls. Split turns and cumulative file tracking are existing correctness constraints.

The first Jev integration will rank retrieved context before provider conversion. Selective compaction is later because changing retained history affects persistence, recovery, branch navigation, and repeated compaction.

### 4.5 Extensions and lanes

Existing hooks are sufficient for shadow evaluation. Existing named lanes can host specialists. The bundled subagent example launches separate Pi processes, while third-party extensions demonstrate persistent sessions and research workflows. We will use those as behavioral references before adding a native child-agent abstraction.

## 5. Operating assumptions

| ID | Assumption | Consequence |
|---|---|---|
| A1 | Jev is materially faster or cheaper than the primary coding model for bounded classification. | Measure end-to-end latency and cost; disable decisions that do not pay for themselves. |
| A2 | Jev outputs typed choices, scores, and binary judgments with probabilities. | Policies consume validated typed results, never free-form text. |
| A3 | Choice always selects the closest candidate even when none fits. | Follow ranking with an independent binary fit check when rejection is valid. |
| A4 | Jev is literal and is weak at counting, arithmetic, date comparison, and long chains of indirection. | Compute facts in TypeScript and present explicit candidates; never ask Jev to calculate them. |
| A5 | Irrelevant state reduces decision quality. | Retrieve deterministically first, then rank a bounded candidate set. |
| A6 | Semantic prompt-injection detection is fallible. | Treat it as telemetry or one policy input, never authorization. |
| A7 | Jev requests can time out, be rate-limited, or be unavailable. | Default to ordinary Pi behavior and record the fallback. |
| A8 | Standard tests cannot depend on a network service or API key. | Inject a deterministic fake client; keep live evaluations separate. |
| A9 | Pi's current tests are the quality floor. | Each core change adds focused regression coverage and keeps existing tests passing. |
| A10 | `main` is the product line and upstream synchronization is optional. | Optimize design for `pi-jev`; use upstream only as a reference. |

## 6. Decisions

### D1: Pi owns the loop; Jev supplies advice

Problem: replacing Pi's loop would discard durable recovery, tool semantics, and years of behavioral tests.

Example: if a tool call is admitted and the process crashes, Jev cannot determine whether the external effect happened. Pi's effect gate already models this state.

Decision: retain Pi's state machine and call Jev only at explicit decision boundaries. Deterministic Pi code validates and applies the result.

### D2: Jev-specific code starts in `packages/coding-agent`

Problem: putting the Jev SDK in `packages/agent` couples the generic harness to one product and makes the durable core harder to test.

Decision: place the client, schemas, prompts, policy, and telemetry in a small `packages/coding-agent/src/jev/` module. Add only generic hook data and persistence required by all callers to `packages/agent`.

Do not create a new workspace package until another package needs to consume the integration independently.

### D3: Start in shadow mode using existing hooks

Problem: routing changes can improve latency while quietly reducing completion quality.

Decision: the first implementation observes existing boundaries, records what Jev would choose, and never changes execution. Shadow mode establishes labeled data, latency, fallback rates, and disagreement with the actual path.

### D4: Add `before_generation` only after shadow instrumentation

Problem: current hooks cannot atomically select model, thinking level, and active tools at the final generation boundary.

Decision: add one provider-neutral hook after shadow telemetry is stable. Its patch is captured with the generation attempt and affects only that attempt unless the application separately changes lane configuration.

### D5: Defer `before_checkpoint`

Problem: stopping or redirecting the loop before another provider call may save work, but an incorrect finish decision is expensive.

Decision: collect checkpoint labels first. Add a core checkpoint hook only if evaluation shows useful precision for continue, verify, clarify, delegate, retry, and finish. Acceptance criteria and pending required work always override a Jev finish recommendation.

### D6: Retrieve first, judge second

Problem: sending an entire repository or session to Jev adds noise and can exceed limits.

Decision: use existing deterministic search—file paths, `rg`, symbols, git history, and indexed docs—to produce candidates. Jev ranks at most the bounded candidate limit, followed by a binary answer-present check. If verification fails, broaden retrieval or use the original Pi context.

### D7: Safety stays deterministic

Problem: semantic risk classifiers can be persuaded by untrusted content.

Decision: tool allowlists, workspace boundaries, confirmation, effect admission, and replay policy remain code. Jev risk judgments may add review or reduce authority, but never grant authority that deterministic policy denied.

### D8: Fail open for optimization, fail closed for authority

Problem: Jev availability must not brick the coding agent, but failures must not bypass safety.

Decision: routing, context selection, and compaction fall back to Pi defaults. Any proposed authority expansion is rejected when its deterministic checks or required confirmation cannot complete.

### D9: Structural compaction follows routing and retrieval

Problem: selective tool-history retention has high leverage but changes persistent context semantics.

Decision: first prototype selective compaction through the existing compaction extension event. Change core compaction storage only after tests prove the extension cannot preserve required invariants.

### D10: Feature branches and reviewable PRs

Decision: implement each milestone on a branch named `feat/jev-<milestone>`. PRs should be small, ordered, and independently testable. A later PR may target the preceding feature branch when it depends on unmerged work; it is retargeted to `main` after its dependency merges.

## 7. Target architecture

```text
user input
   |
   v
Pi admission and durable run state
   |
   +--> deterministic candidate construction
   |       - lane configuration
   |       - available skills/tools
   |       - retrieved context
   |       - checkpoint facts
   |
   +--> Jev typed decision
   |       - Choice: rank/select
   |       - Noul: verify/reject
   |       - Score: confidence/risk signal
   |
   +--> deterministic policy
   |       - validate schema and confidence
   |       - enforce authority and invariants
   |       - choose fallback when unavailable
   |
   v
Pi generation, tools, persistence, recovery, and UI
```

Only the deterministic policy can mutate execution. Raw Jev answers are evidence, not commands.

## 8. Decision request and record

The SDK-specific response stays behind the coding-agent adapter. Internal code uses a narrow record:

```ts
interface JevDecisionRecord {
  id: string;
  operationId: string;
  boundary: "run" | "generation" | "checkpoint" | "compaction";
  schemaVersion: number;
  candidateIds: string[];
  answers: Array<{
    questionId: string;
    value: string | boolean | number;
    probability?: number;
  }>;
  action: string;
  fallback?: string;
  durationMs: number;
}
```

This is a proposed shape, not a public abstraction. The first implementation should use the smallest subset required by shadow telemetry. Do not persist raw prompts, repository contents, tool output, secrets, or full messages by default. Stable candidate IDs and schema versions must make a record interpretable after code changes.

## 9. Implementation milestones

### Milestone 0: Baseline and fixtures

Branch: `feat/jev-baseline`

Work:

1. Record baseline scenarios for coding, tool-heavy work, repository research, and deep research.
2. Define labeled JSON fixtures for route, relevance, completion, and compaction judgments.
3. Capture current completion, model calls, tool calls, context tokens, wall time, and failures.
4. Add no runtime dependency and change no execution behavior.

Acceptance:

- fixtures contain no secrets or proprietary repository content;
- scenarios run without provider access where possible, using the faux provider;
- the baseline report can compare later Jev-enabled runs.

### Milestone 1: Jev client and shadow decisions

Branch: `feat/jev-shadow`

Files expected:

- `packages/coding-agent/src/jev/client.ts`
- `packages/coding-agent/src/jev/shadow.ts`
- `packages/coding-agent/src/jev/types.ts`
- focused tests beside existing coding-agent tests
- package manifest and lockfile only if the official SDK is added

Work:

1. Add the official TypeScript SDK as an exact-version dependency after reviewing its exported types in `node_modules`.
2. Read `TYPESAFE_API_KEY` through existing configuration patterns; never persist or print it.
3. Wrap only the SDK calls needed for Choice, Noul, and Score. Do not create a generic provider interface with one implementation.
4. Accept an `AbortSignal`, impose a bounded timeout, validate response shape, and classify no-key, timeout, rate-limit/service, and invalid-response failures.
5. Attach shadow observers to existing run, request, tool, compaction, and terminal hooks.
6. Emit structured records without changing model, tools, context, or loop control.

Fallback: omit the shadow decision when configuration is absent; record a failure category when configured calls fail.

Tests:

- fake successful typed responses;
- missing key disables calls;
- timeout and abort stop observation without mutating the run;
- malformed responses are rejected;
- sensitive input is absent from default telemetry;
- existing hook order remains unchanged.

### Milestone 2: Pre-generation routing

Branch: `feat/jev-generation-routing`

Core problem: the current hook set cannot change the model, thinking level, and visible tools together at the final generation boundary.

Core change:

1. Add a `before_generation` hook in `packages/agent` immediately before generation configuration is captured.
2. Give it immutable facts: operation, turn, attempt, current model, thinking level, active tool names, and projected context metadata.
3. Allow a patch containing only model identity, thinking level, and active tool names.
4. Validate referenced model and tool identities through existing registries.
5. Capture the applied patch in the durable generation state before admitting a provider effect.
6. Reuse that captured patch after restart; never call the hook again for the same admitted attempt.
7. Keep lane configuration unchanged unless an existing setter is called.

Jev policy:

- first Choice ranks route candidates such as `fast`, `standard`, `deep`, and `research`;
- an optional Noul verifies that the top route fits;
- TypeScript maps the route to concrete model, thinking level, and tools;
- low confidence or failure returns no patch.

Example trace:

```text
run admitted
-> context projected
-> route candidates built from available models/tools
-> Jev selects "research" and verifies fit
-> policy maps it to model X, high thinking, web/read tools
-> patch committed with generation attempt
-> provider effect admitted
```

Tests:

- no hook produces byte-for-byte equivalent configuration behavior;
- a patch affects one attempt only;
- invalid model/tool patches fail in-band before provider admission;
- crash restore uses the captured decision without calling the hook twice;
- retry behavior is explicit: retries reuse the route unless a new generation attempt is defined by the state machine;
- abort reconciliation makes no Jev call;
- hook order and error isolation match existing hook contracts.

### Milestone 3: Skill and tool routing

Branch: `feat/jev-skill-tool-routing`

Work:

1. Build candidates from the already-loaded skill catalog and active tool registry.
2. Rank a broad skill shortlist, rerank the top few, then ask an independent fit question so no skill remains a valid result.
3. Select tool visibility at `before_generation`; do not select open-ended arguments.
4. Derive enum-like or bounded arguments only when every value is present in the candidate set. Leave paths, commands, prose, identifiers, and other open values to the primary model or deterministic code.
5. Preserve explicitly required tools even when Jev omits them.

Tests cover zero candidates, one candidate, ties, reject-all, unknown IDs, low confidence, required tools, and stable ordering.

### Milestone 4: Semantic context selection

Branch: `feat/jev-context-selection`

Work:

1. Reuse deterministic repository search and session projection to create small candidate records.
2. Rank no more than 255 candidates per Choice request.
3. Verify answer presence with a Noul before dropping ordinary context.
4. Apply selection in the existing context transformation boundary without changing stored transcript entries.
5. Always retain current user instructions, system policy, unresolved tool calls/results, active task constraints, and durable operation facts.
6. Fall back to current Pi projection when verification fails.

Initial candidate record:

```ts
interface ContextCandidate {
  id: string;
  source: "message" | "file" | "symbol" | "git" | "document";
  label: string;
  excerpt: string;
  required: boolean;
}
```

The excerpt has a strict size limit. Full content is loaded only for selected IDs.

Tests verify required-item retention, call/result pairing, stable ordering, candidate limits, verification fallback, and no transcript mutation.

### Milestone 5: Checkpoint controller

Branch: `feat/jev-checkpoints`

Entry condition: shadow data demonstrates that checkpoint decisions can avoid model calls or catch premature completion at acceptable precision.

Core change, if justified:

1. Add `before_checkpoint` at the existing finish/continue mediation point.
2. Expose computed facts, not raw mutable harness state: pending queues, tool outcomes, acceptance-criteria status, retry state, and candidate actions.
3. Allow `continue`, `verify`, `clarify`, `delegate`, `retry`, or `finish`.
4. Convert non-finish actions into an ordinary durable follow-up input before another provider effect.
5. Ignore `finish` when deterministic required work, queued user input, unresolved effects, or failed acceptance criteria remain.

Tests cover every state-machine leaf that can reach the boundary, restart after decision capture, queued-message precedence, finish override, abort, and hook failure.

If the entry condition is not met, skip this milestone. Existing loop behavior is sufficient.

### Milestone 6: Selective compaction

Branch: `feat/jev-compaction`

Reference behavior: `tamaratran/fast-jev-compaction` uses Jev to decide which tool interactions remain useful while preserving user and assistant narrative.

First implementation:

1. Use `session_before_compact`; do not change core storage.
2. Build units that keep assistant tool calls paired with their tool results.
3. Compute deterministic required units: unresolved work, modified files, recent failures, active constraints, and the retained tail.
4. Ask Jev to classify optional units as retain, truncate, or drop.
5. Enforce token budgets and structural invariants in TypeScript.
6. Produce the existing structured summary and file-operation details.
7. Store decision metadata in `details` only when JSON-serializable and privacy-safe.

Core storage changes are allowed only if the extension cannot express a correct retained history. Any such PR must preserve:

- valid cut points;
- tool-call/result pairing;
- split-turn behavior;
- repeated compaction boundaries;
- cumulative file tracking;
- branch summaries;
- token accounting;
- restart and overflow recovery.

Tests compare reconstructed provider context before and after compaction and include repeated compaction, split turns, large tool output, failures, empty selections, and Jev fallback.

### Milestone 7: Specialist lanes and research

Branch: `feat/jev-specialists`

Work:

1. Route to named existing lanes for bounded roles such as code search, implementation, test diagnosis, web research, and citation verification.
2. Start with sequential delegation. Add parallel execution only where tasks are independent and merge behavior is deterministic.
3. Enforce depth, cycle, concurrency, and token limits in code.
4. Require specialists to return structured findings with source IDs rather than unrestricted transcript injection.
5. For research, apply separate judgments for relevance, contradiction, answer evidence, and suspected prompt injection.
6. Verify claim/source relationships before presenting citations.

Do not add a native child-agent API unless lanes cannot provide isolation, cancellation, and accounting required by measured workflows.

Tests use faux providers and local fixtures. They cover cycles, depth, partial failure, cancellation, citation mismatch, contradictory evidence, deterministic merge order, and usage accounting.

## 10. Jev question design

Questions must be short, independent, and answerable from explicit state.

Good:

```text
State: task requests repository-wide symbol references; candidates are code-search,
implementation, web-research. Which candidate best matches the next action?
```

Bad:

```text
Understand everything that has happened and decide what the agent should do.
```

Rules:

1. Compute counts, thresholds, paths, dates, and policy facts in TypeScript.
2. Use stable candidate IDs and put descriptions in state.
3. Batch independent questions when they use the same compact state.
4. Do not let one answer appear as hidden state for another; make dependencies explicit in code.
5. Calibrate probability thresholds on labeled fixtures rather than guessing.
6. When no candidate is valid, verify the selected candidate independently.
7. Version question schemas whenever meaning or candidate mapping changes.

## 11. Configuration

Initial configuration should be minimal:

```json
{
  "jev": {
    "mode": "off"
  }
}
```

Supported modes should grow only with implementation:

- `off`: no SDK initialization and no behavior change;
- `shadow`: record decisions, do not apply them;
- `route`: apply only validated generation routing;
- `on`: enable individually released features.

The API key comes only from `TYPESAFE_API_KEY`. Timeouts and thresholds should use code defaults until evaluations prove users need configuration. Avoid a settings surface for every prompt or probability.

## 12. Failure handling

| Failure | Behavior |
|---|---|
| No API key | Treat Jev as off; do not warn on every turn. |
| Caller abort | Cancel the request and preserve the operation's existing abort semantics. |
| Timeout | Record category and use Pi default. |
| Rate limit or service unavailable after SDK retry | Record category and use Pi default. |
| Invalid typed response | Reject the decision and use Pi default. |
| Unknown candidate ID | Reject the decision and use Pi default. |
| Low confidence | Use Pi default or request verification; never invent a candidate. |
| Telemetry failure | Do not affect the run. |
| Deterministic safety failure | Deny or require confirmation regardless of Jev output. |

Logs must not include the API key, raw authorization headers, secrets, complete tool results, or full repository context.

## 13. Observability

For each attempted decision, capture:

- operation and boundary IDs;
- question schema version;
- stable candidate IDs;
- answer and available probability;
- applied action or fallback reason;
- duration and SDK usage when available;
- eventual outcome: completion, retry, error, user correction, or regression label.

Shadow reports should answer:

1. How often would Jev change Pi's path?
2. Which changes correlate with success or failure?
3. What are p50 and p95 decision latencies?
4. How often is fallback used, and why?
5. How many model calls, tool calls, and context tokens would be saved?
6. How often would Jev finish prematurely or omit required context/tools?

## 14. Test strategy

### 14.1 Unit tests

Use an injected fake at the smallest call boundary. Fixtures return exact Choice, Noul, and Score responses or explicit failures. Tests must not read a real key or use the network.

Every behavior-changing PR adds a test that fails against its parent branch. Core state changes require restart tests at each new durable crash position.

### 14.2 Integration tests

Use `packages/coding-agent/test/suite/harness.ts` and the faux provider. Exercise hook order, session reconstruction, generated requests, tool visibility, queues, compaction, cancellation, and usage accounting.

### 14.3 Evaluation tests

Live Jev evaluations are opt-in and separate from the standard suite. Compare:

- Pi baseline;
- Jev shadow;
- one enabled feature at a time;
- all released features.

Datasets cover routing, skill choice, tool visibility, context relevance, completion verification, selective compaction, tool risk, research evidence, and citation support.

Primary metrics are task completion and regression rate. Secondary metrics are latency, cost, primary-model calls, tool calls, frontier tokens, context retained, fallbacks, and premature finish.

### 14.4 Required commands

For each code PR:

1. Run every changed or added test directly using the repository-prescribed Vitest or `node:test` command.
2. Run `npm run check` and fix all errors, warnings, and infos.
3. Run `./test.sh` before requesting final review when the change crosses package boundaries or alters the execution state machine.

Do not run provider-backed end-to-end tests in the standard suite.

## 15. Pull request sequence

| Order | Branch | Review focus |
|---:|---|---|
| 1 | `docs/jev-harness-plan` | assumptions, decisions, milestones, invariants |
| 2 | `feat/jev-baseline` | fixtures and measurement only |
| 3 | `feat/jev-shadow` | SDK boundary, errors, telemetry, no behavior change |
| 4 | `feat/jev-generation-routing` | durable core seam and recovery |
| 5 | `feat/jev-skill-tool-routing` | bounded candidates and reject-all behavior |
| 6 | `feat/jev-context-selection` | required context and safe fallback |
| 7 | `feat/jev-checkpoints` | only if shadow results satisfy entry criteria |
| 8 | `feat/jev-compaction` | structural context invariants |
| 9 | `feat/jev-specialists` | isolation, budgets, research evidence |

PR descriptions must include the problem, a short execution trace, the solution, test evidence, fallback behavior, and measured effect. Avoid combining milestones to reduce review ambiguity.

## 16. Release gates

A feature moves from shadow to enabled only when:

1. labeled accuracy meets its documented threshold;
2. no high-severity baseline regression remains unexplained;
3. p95 latency is within the feature budget;
4. Jev failure produces the verified Pi fallback;
5. abort and restart behavior is tested;
6. telemetry can attribute the applied decision;
7. deterministic safety and authority checks remain effective;
8. the feature can be disabled without migrating session data.

## 17. Deferred decisions

These are intentionally unresolved:

- whether `before_checkpoint` is worth a core hook;
- whether selective compaction needs a new persisted entry shape;
- whether specialists need native child operations instead of lanes;
- whether Jev decisions should become first-class session entries;
- whether a separate workspace package is warranted;
- exact probability thresholds and model mappings;
- parallel specialist execution and merge policy.

Resolve each only from implementation evidence. Until then, use existing hooks, lanes, context projection, and compaction events.

## 18. References

- Pi durable harness contract: `packages/agent/docs/harness.md`
- Pi compaction behavior: `packages/coding-agent/docs/compaction.md`
- Pi extension surface: `packages/coding-agent/docs/extensions.md`
- Pi bundled subagent example: `packages/coding-agent/examples/extensions/subagent/`
- Jev semantic find cookbook: <https://docs.typesafe.ai/cookbooks/semantic_find>
- Jev cookbooks: <https://docs.typesafe.ai/cookbooks>
- Fast Jev compaction reference: <https://github.com/tamaratran/fast-jev-compaction>
