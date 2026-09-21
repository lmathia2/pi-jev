# ADR 3: Recoverable evidence and offline learning

Status: accepted. Date: 2026-09-20.

## Problem

A selector can appear cheaper by deleting evidence needed to finish the task. A comparison can appear better by assigning the chosen model's success to unexecuted alternatives. Neither is a valid quality improvement.

For example, removing an irrelevant-looking search hit must not make its original unrecoverable; a failed tool followed by a successful identical retry must not force endless verification.

## Decision

Fresh-output and built-in search selection preserve required/dependent groups and store exact originals before replacing visible text. `recall_output` reads only the current branch and supports line ranges. Recovery survives disabling inference. Truncated search results, errors, protected source/diff output and explicit complete-output requests are retained. Historical tool selection is covered by [ADR 4](0004-context-window-management.md); arbitrary dialogue pruning is not implemented.

Tool review operates on proposed calls; it may block but never grant permissions. Completion uses bounded existing follow-ups, respects pending input/cancellation and tracks the latest result for identical tool/argument checks. Changed arguments are a different check; richer check identity belongs to the producing tool rather than a speculative global inference mechanism.

Offline comparisons invoke alternative implementations on independent copies of the same request and use one admission function. Capture is consented; full input capture is separately opted in. Metadata-only rows are not replayable. Results are copied before admission/reporting, and each variant ID must have one policy identity. Unknown cost stays unknown, including failed or rejected proposals.

Learning uses grouped train/development/holdout data, an operator-bounded search and immutable candidate versions. Jev-align imports convert accepted definition text under a fixed output contract; they do not import credentials, permissions, budgets or optimizer-reported authority. Holdout gates bind candidate digests; explicit promotion keeps a previous digest for rollback. Re-promoting an active candidate must not overwrite that rollback pointer.

## Consequences

- Prompts, criteria and numeric decision parameters are learnable data. Required evidence, input validation, allowed actions and evaluation gates remain deterministic host constraints.
- Exact originals are local session content, not metadata-only telemetry. Remote inference receives projected task/tool text; bounded length is not redaction. Hosts must apply their data policy before inference/export.
- A proposal-only comparison reports agreement, rejection, failure, latency and reported cost. Complete-task trials are needed to measure actual model quality and total savings.
- GEPA execution, report provenance and activation into live sessions remain operator workflows. The synthetic learning roundtrip proves plumbing only.
- Regression tests use the existing fake-provider harness and compact failing traces. No new test framework, real-provider fixtures, optimizer service or search engine is necessary.

Implementation: [components](../../packages/coding-agent/src/jev/decision-components.ts), [evaluation](../../packages/decisions/src/evaluation.ts), [learning](../../packages/decisions/src/learning.ts), [experiment queue](../jev-experiments.md).
