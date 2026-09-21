# Jev experiment queue

Correctness fixtures do not establish usefulness. Keep each component opt-in until its experiment passes. Use fixed task/session groups and operator-owned gates; preserve an untouched final holdout. Record policy digest, implementation/model version, candidate roster, data projection, budgets, repetitions, and measured cache usage with each result.

## Available offline workflow

`packages/decisions/src/evaluation.ts` compares proposal implementations on independent copies of identical requests with one host admission callback. It executes no tools. `groupedSplit` assigns complete tasks consistently; `calibrateNumericParameter` accepts only development examples and an operator-bounded search.

`packages/decisions/src/learning.ts` captures JSONL only with explicit consent. Input capture is a separate option; without it, records are non-replayable. The caller must redact inputs before both inference and capture. `exportJevAlignInputs` exports training or development input rows; holdout is excluded. Human labels and rationales are reviewed in the optimizer workflow, not inferred from user overrides.

`importJevAlignDefinition` converts the accepted artifact's `definition` field using an operator-supplied fixed outcome contract. It accepts binary, multiclass, multilabel and score definitions, rejects changed output IDs and extra fields, and imports only text. It does not import optimizer metrics, model credentials, budgets, or permissions. For dynamic model rosters, optimize a stable rubric or use a custom evaluator rendering each row's candidate roster; fixed Choice labels are not portable model IDs.

`importJevAlignPolicy` wraps imported text in a new immutable version, preserves the seed's runtime parameters and records source digests. Evaluate the frozen candidate on holdout, and call `promotePolicy` with an independently generated report and gate. Persist the returned digest pointer through the host's existing state mechanism and activate it at an admitted boundary. `rollbackPolicy` selects the previous digest. These helpers do not independently attest report provenance or activate live sessions. Imported policy shapes must match the implementation; the bundled Jev adapter uses Choice selection, binary subset judgments and raw binary retention probabilities.

Run the synthetic export/import, isolation, calibration, promotion and rollback checks:

```sh
cd packages/decisions
node ../../node_modules/vitest/dist/cli.js --run test/core.test.ts test/jev.test.ts test/learning.test.ts
```

From the repository root, run the complete synthetic workflow (training export, grouped development calibration, paired sealed-holdout comparison, candidate import, promotion and rollback) without network access:

```sh
node --experimental-strip-types packages/decisions/examples/learning-roundtrip.ts
```

The example uses recorded numeric fixtures and an accepted-definition fixture. It checks plumbing and invariants, not real Jev quality or GEPA optimization. It prints a report and does not modify live settings.

## Experiments to run

- [ ] Establish a no-decision baseline on representative coding tasks with isolated workspaces, fixed model/effort and equal budgets. Measure verified completion, complete-task cost and p50/p95 latency.
- [ ] Compare baseline, deterministic heuristic, Jev seed policy and learned policy on paired redacted snapshots. Report invalid proposals, abstentions, admission rejections, label agreement, latency and known/unknown cost separately.
- [ ] Run complete-task routing trials; proposal agreement alone cannot measure the performance of an unchosen model. Include cache reads/writes and decision overhead in total costs.
- [ ] Measure cache break-even under short and long phases, cold and warm prefixes, effort changes and tool-profile changes. Calibrate expected remaining work and uncertainty margins on development data only.
- [ ] Calibrate `generation.phase/v1` instructions, phase descriptions and probabilities on labeled settled-tool boundaries within a frozen transition graph. Compare explicit phases with the classifier; measure premature/missed transitions, stay frequency, calls per task, phase-budget exhaustion and downstream cache churn. Verify duplicate result checks, initial generations and retries cause no extra classification or rerouting.
- [ ] Train a first stable rubric with jev-align/GEPA; archive input digests, accepted definition, calibration search and sealed holdout report. Rehearse promotion and rollback before live enablement.
- [ ] Compare fresh-output selection against unchanged output. Measure required-evidence recall, exact recall after branch/reload and after disabling inference, recall frequency, completion and total cost. Include errors, diffs, source reads, parallel results and requests for complete output.
- [ ] Evaluate phase-owned tool/skill selection with explicitly required skills, required tools and profile changes that invalidate cache. Include transitions that restore previously excluded skills. Measure task completion and unnecessary schema tokens.
- [ ] Evaluate built-in grep/find retrieval selection with file groups, required evidence and truncated-result bypass; evaluate custom retrieval backends separately. Judge whole-task quality; lower returned bytes alone is insufficient.
- [ ] Evaluate completion review with failed tests, unsupported claims, pending user messages and continuation limits. Track false acceptance and unnecessary verification separately.
- [ ] Evaluate tool review offline on known allow/deny and uncertain actions. Measure false approvals and false blocks; verify no semantic result grants permissions.
- [ ] Evaluate composed components after individual wins. Check interactions between routing, tool profiles, output selection and completion loops under the same total budget.
- [ ] Compare context retention against unpruned context and standard summarization on identical tasks. Measure required-evidence loss, exact recovery, task-switch restoration, final correctness and total cost including scoring, recall and fallback summaries.
- [ ] Calibrate context rubric, `keepThreshold`, excerpt sizes, pressure/target ratios and recent-message protection on grouped development tasks; compare the learned policy on untouched holdout. Include relevant facts hidden in result middles and ambiguous call/result dependencies.
- [ ] Measure actual prompt/cache usage against context estimates across providers, scripts, tool-schema sizes and multimodal inputs. Test smaller-window routes, fixed-prompt overflow and summary failures; verify phase pinning saves enough to cover selection churn.
- [ ] Add random audit samples alongside uncertain-example acquisition; retain selection probability and task/repository/time grouping to measure sampling bias and leakage.
- [ ] Compare context `cacheAware` true/false on identical task groups: calls avoided, estimated versus observed prefix reuse, cache reads/writes, total spend and evidence retention. Calibrate horizon/margin on development only; include unknown prices, changed task/configuration/failure state, manual/overflow and hard-pressure bypass.
- [ ] Verify preconstruction selection uses raw history/current input and overhead estimates, with no post-render gate or second ordinary semantic call. Measure render/estimate mismatches and provider overflow recovery, including summary fallback and multimodal inputs.
- [ ] Test a second independent optimizer or local predictor using the same artifact and evaluation contracts, without changing harness adapters.

Paid inference and optimizer runs are separate, explicitly configured experiments. No synthetic test result should automatically enable a component.

## Engineering follow-ups, not experiment results

- [ ] Resolve the pre-existing generated model-catalog/type mismatch so the full repository check can complete.
- [x] Add preconstruction estimated total-budget admission and a context floor before allowing smaller-window routing candidates; residual render/estimate overflow uses provider recovery, not a post-render gate.
- [ ] If extreme histories require it, bound the legacy summarizer's own request; current estimated preparation budgets do not bound summary-provider requests.
- [ ] If automatic live policy promotion is needed, connect reviewed reports and persisted digest pointers to an admitted host boundary; resource reload is already supported.
- [ ] For custom durable hosts, persist phase/policy identity and supply private snapshots/admission through the existing adapter. Do not add another runtime solely for this.
- [ ] Define a concrete workflow before adding semantic recovery, specialist dispatch, research-evidence classification or arbitrary dialogue pruning.
