# ADR 2: Phase boundaries and host authority

Status: accepted. Date: 2026-09-20.

Updated 2026-09-21: [ADR 6](0006-bounded-workflows-and-gap-closure.md) makes same-phase commands idempotent, removes the configured legacy bypass, prices all target inputs cold, and adds optional durable session reservations. Target cache reuse is never assumed for switch admission. Hosts supplying `persistence` retain lane/phase and policy/roster identity across restarts; host snapshot/admission callbacks remain authoritative.

## Problem

Selecting a model after rendering its prompt is too late: tool schemas, skill visibility and model-specific instructions may already reflect the previous choice. Switching every turn also repeatedly pays for a cold prompt cache.

A second race occurs during application: routing awaits authentication/model listeners, a listener selects low effort, and routing then writes high effort from an older proposal. The final configuration no longer represents one coherent decision.

## Decision

The normal `AgentSession` emits `before_generation` for initial and continuation preparation, before prompt/schema assembly. The routing adapter uses bounded private state, current configuration, pending input, observed tool results and cache/context usage. Prompt-option edits happen before pricing; enabled skill selection filters the full loaded roster and pins visibility to the same phase.

Order:

`settled boundary → admitted phase → skill visibility → route proposal → cost/freshness checks → joint configuration commit → raw-history context selection and estimated admission → prompt/schema assembly → provider`

A route is a complete model, reasoning-effort and tool preset, never a partial inheritance from an old route. Candidate filtering enforces available authentication, scopes, supported effort/input, required tools and context-window constraints. The host checks freshness again after asynchronous authentication and commits all three choices synchronously before notifications. Later listener/user changes win; the route trace reports supersession rather than overwriting them.

Persist phase decisions on the current session branch. Initial routing and explicit phase commands establish boundaries. Optional phase classification only evaluates newly settled tool-result boundaries against operator-configured transitions; staying does not reroute. Turns, retries and reload alone do not create new phases.

Compare estimated future stay/switch cost. Charge the first cold target once, not once as input and again as lost-cache value. A switch needs sufficient estimated savings or an explicit capability cost cap. Unknown estimates cannot prove savings. Treat changed model/effort/tools conservatively as cold; do not promise provider-specific cache survival.

## Consequences

- No model-facing prompt is needed to choose the model. Private routing features are separate from the prompt projection.
- Skills and route pricing share one phase owner; built-in skill enablement therefore requires routing configuration. A new phase selects from the full loaded roster, not the prior filtered subset.
- Estimates use configurable remaining work, margins and token-estimator calibration. Model-registry tariffs are inputs, not an optimizer's invented prices. Real cache economics need experiments.
- Smaller-window targets require enabled context management and its pre-render feasibility floor. Context selection and estimated admission happen before rendering; there is no postconstruction gate. Estimate/render mismatches use provider overflow recovery; see [ADR 4](0004-context-window-management.md).
- The normal-session commit is synchronous in memory, not transactional on disk. A pending record plus missing completion record conservatively pins restored state after interruption rather than replaying an old proposal.
- The separate durable `AgentHarness` adapter uses existing pre-generation checkpoints and passes selected configuration to the prompt callback. Its host owns durable phase identity, snapshot construction and admission; it is not implicitly installed into normal CLI sessions.

Implementation: [routing](../../packages/coding-agent/src/jev/decision-routing.ts), [skill selection](../../packages/coding-agent/src/jev/decision-selection.ts), [session](../../packages/coding-agent/src/core/agent-session.ts), [durable adapter](../../packages/coding-agent/src/jev/decision-durable.ts).
