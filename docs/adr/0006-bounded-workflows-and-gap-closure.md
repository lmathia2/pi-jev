# ADR 6: Guarded routing and bounded workflows

Status: accepted. Date: 2026-09-21. Supplements ADRs 2–5.

## Problem and concrete failures

Two identical `/decision-phase verify` commands created different entry IDs, permitting a second route decision without a semantic transition. Legacy `route` bypassed all new guards. Routing assumed future target cache hits. Component evaluators discarded invocation metadata. Recovery, evidence and specialists lacked concrete host workflows, and extreme summary requests reached providers without admission checks.

## Decisions

1. Compare the requested phase to the current effective phase before appending a transition. Repeating it is a no-op. No new phase framework is necessary.
2. Keep one configured routing path. `route` accepts a complete `decisions` configuration as a migration alias; partial legacy profiles do not execute. Explicit legacy helper APIs remain available to custom hosts but are not selected by startup settings.
3. Price target input cold on every estimated remaining request. Compare against favorable current-cache reuse, retain the uncertainty margin and separately bounded capability escalation. Do not claim cache portability or measured savings. Horizons/output/classifier fees remain estimates pending experiments.
4. Carry invocation metadata through component and skill results: implementation/version, digests, duration, request/token counts and reported cost. Unknown usage remains null. Keep raw task/source/provider evidence out of those records.
5. Implement three independently configured finite workflows through existing hooks and tools: failed-result recovery guidance; claim/source-ID classification; approved specialist selection followed by one tool-free consultation. The primary model requests consultations/evidence checks. There is no autonomous child tree, direct mutation, generated command or retry authority.
6. Persist workflow allowances before inference on the current branch. Failures consume allowances. Validate source provenance, model scope/effort, context/cost estimates, timeout, cancellation and final freshness. Fail safe to unchanged errors, insufficient evidence or no dispatch.
7. Admit every summary request at the existing shared `completeSummarization` boundary. Oversized input plus output/margin fails before provider execution; history is not silently truncated or deleted. Chunked summaries and exact tokenizers are separate work.
8. Let durable adapters reuse a host-supplied disk-backed SessionManager for lane/phase reservations and policy/roster digests. Reserve and explicitly `flush()` before inference, even before the first assistant response. Ordinary unused sessions retain lazy creation; explicit flush writes/fsyncs existing buffered entries. Keep recovered driver configuration after interruption and never repeat the decision within the same boundary. The host still supplies phase IDs and final live admission; the driver owns configuration checkpointing.

## Limits and consequences

The smallest bounded specialist path is a single tool-free model consultation using supplied evidence, not a replacement subagent engine. It cannot gather new evidence itself; ordinary parent tools supply it. Source IDs establish session provenance, not factual correctness. Advisory specialist prose may still be wrong. Recovery guidance never automatically retries a side effect or changes phase/model.

Summary and cost admission are conservative estimates, not provider billing/tokenizer guarantees. Cold-target arithmetic intentionally rejects some switches that might have saved money with real cache hits. Independent live experiments remain deferred.

Existing registry, session metadata, tool dispatch and provider authentication supply the runtime. No dependencies, optimizer daemon, plugin installer or second durable store were added. Offline tests validate wiring, guards and fallback, not semantic quality.

See [configuration and limits](../jev-workflows.md), [workflow code](../../packages/coding-agent/src/jev/decision-workflows.ts), and [implementation log](../jev-implementation-log.md).
