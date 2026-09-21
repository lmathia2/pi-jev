# DeepSWE: replacing LLM control decisions with Jev

## Hypothesis and scope

Can Jev replace a general LLM at bounded harness decision points without reducing verified task completion, while reducing decision latency and total task cost?

This is **not** replacement of the coding model. Code generation, tool arguments, free-form planning, summaries and specialist findings remain generative work. Pi's default harness does not already call a general LLM at every decision point: this experiment adds an explicit LLM comparator to the existing decision interface. Do not describe it as an unchanged upstream-Pi LLM baseline.

The setup uses Datacurve's [Pier](https://github.com/datacurve-ai/pier) and [DeepSWE](https://github.com/datacurve-ai/deep-swe), not the unrelated DeepSWE model/training project. Inspected revisions:

- Pier: `0c802fc067a425345b24d1c69411aa98acf61a1d` (package version 0.3.1).
- DeepSWE: `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`.

DeepSWE has 113 tasks. Its v1.1 verifier applies agent commits in a pristine, separate container. Leave task images, instructions, verifier, resource limits and collection hooks unchanged. The runner reminds the agent to commit; it never silently commits unverified work or copies reference solutions into the task.

## Arms

| Arm | Coding model | Decision implementation |
| --- | --- | --- |
| `control` | Same initial model and effort | No experiment decision adapters; normal Pi behavior |
| `llm` | Same initial model and effort | `experiment.llm`: tool-free JSON probability judgments |
| `jev` | Same initial model and effort | Existing `jev.typed` Choice/Noul adapter |

The primary comparison is **routing-enabled `llm` versus routing-enabled `jev`**. Each controller chooses phase transitions and model/reasoning presets, as well as the other enabled decisions. Different admitted routes are an intended effect of the controller. The control tells us whether either controller improves upon normal Pi. It stays at the initial model/effort and intentionally lacks the decision adapters' extra recall tools, so it is not the implementation-only comparison.

Both active arms use the same rubrics, input projection, candidate order, thresholds, protected evidence, budgets, fallback rules and host admission. There is no shadow execution and no LLM fallback for failed Jev decisions. Failures use the existing deterministic component fallback.

LLM probabilities are self-reported estimates; Jev probabilities come from its typed classification service. They are not identically calibrated. Freeze 0.7 for the initial seed comparison and report abstentions separately. If thresholds are tuned, tune each on development tasks under the same quality constraint, then freeze before holdout. Do not tune on final verifier results.

## Manifest

Edit `packages/coding-agent/examples/deepswe/experiment.json` in an operator-owned copy. JSON is the experiment manifest; `evals/deepswe/pier.yaml` configures orchestration. No credentials belong in either file.

- `generator`: initial provider/model/effort, currently **Muse Spark 1.3 Contributor, xhigh**.
- `controller`: independently configurable LLM comparator, initially Muse Spark 1.3 Contributor **low**, 4096 output tokens including reasoning. This is an explicit experimental choice, not a claim that low is optimal. Run an xhigh-controller ablation if quality differs.
- `models`: normal Pi models.json configuration, including API URL, environment-key reference, context limits, effort mappings and pricing. The runner disables network catalog refresh and records the supplied manifest digest.
- `routingEnabled`: true by default, enabling the phase classifier and complete model/effort/tool presets in both active arms. Set false in a separate paired ablation to hold the coding model fixed. The control always disables routing.
- `allowContributorDataUse`: true, explicitly authorized by the user for submitted data. Generator, controller and routing presets use Contributor models. This permission does not authorize spending or a benchmark launch. Set false to prohibit Contributor models in a future private-data experiment.
- `maxTurns`: 200 completed generator turns across continuations. Pier independently enforces the 3600-second wall-clock timeout. These are not dollar spending caps: configure provider-side quotas before launching.
- Component decisions share a 200-invocation allowance; routing and phase classification have separate 12/80 allowances. Both implementations disable provider retries for their decisions. Normal generator retries are disabled too.

Unknown models/efforts/auth, invalid component configuration, invalid arms and unreviewed contributor use fail startup rather than silently becoming control trials. An advertised model still needs account access and a live smoke test; configured-auth presence does not prove endpoint eligibility.

### Decision coverage

| Point | Initial manifest | Effect |
| --- | --- | --- |
| Fresh output selection | On | Retain subsets of eligible bash output; exact recall remains available |
| Retrieval selection | On | Retain eligible grep/find results; protected groups survive |
| Context retention | On, cache-aware | Score old call/result pairs; host maps scores to keep/excerpt/omit |
| Completion verification | On, two continuations | Accept, verify or clarify; failed checks still force verification |
| Error recovery | On, ten calls/task | Continue, inspect or clarify; no autonomous tool replay |
| Phase classification | On | Stay or transition on newly settled tool boundaries |
| Model/effort/tool routing | On | Select a complete approved preset; host admits it |
| Tool review | Opt-in ablation | Proceed, block or request review; never grants permissions |
| Skill selection | Off | Requires a frozen nonempty skill roster and phase routing |
| Specialist dispatch / evidence review | Off | Optional adapters already exist; add identical configs/bindings in both arms |

`tools.profile/v1` and `context.select/v1` are library contracts, not additional independent live sites in this runner. Tool profiles travel in generation presets; the context adapter uses `context.retention/v1`. Do not count unused definitions as evaluated features. A 1M-token model may never trigger context retention: report actual invocation counts, not merely enabled flags. Use a separately declared pressure ablation if needed.

### Routing and cache economics

The roster includes Muse Spark 1.3 xhigh/high/low and Muse Spark 1.2 high. Add medium/minimal by copying a complete preset. Routes contain previous decisions in their private state and can only change at initial/phase boundaries, never arbitrary tool turns.

The current cost guard charges cold target input and refuses to fund switching using hypothetical cache hits. It cannot guarantee that a provider preserves a cache across model or effort changes.

Important limitation: 1.2 and 1.3 have identical published tariffs; lower reasoning effort changes actual generated tokens, not the tariff. The current routing estimator uses one output-token estimate for every route. Rather than invent effort discounts, the primary manifest explicitly sets `decisions.routing.escalationMaxUsd: 0.25`. This existing host policy admits same-price model/effort exploration when estimated target-phase cost, including cold cache and decision overhead, is at most $0.25. Traces label those admissions `capability`, not `economy` or proven savings. The same cap applies to both arms.

The estimate uses three future requests, 6000 total output tokens and at least $0.01 routing-decision overhead. These are frozen seed assumptions, not calibrated forecasts or spending limits. At Contributor rates, 100K input tokens gives a cold-switch estimate of $0.0412; 1M gives $0.3112 and fails this capability cap. The existing economy path can still admit a genuinely cheaper route above the capability cap if savings exceed the $0.01 margin. The cap does not limit staying on the current model, whole-task spend, or provider billing; keep provider-side quotas and the wall-clock/turn limits.

Calibrate on development tasks and freeze the cap before holdout. Report actual generation tokens, cache behavior, routing overhead, rejected proposals and verifier quality. Lower effort may or may not save money. A route-specific output forecast is future work requiring measured data; none is fabricated here.

## OpenRouter candidates (checked 2026-09-21)

From the [live OpenRouter catalog](https://openrouter.ai/api/v1/models), USD per million tokens; headline prices may aggregate providers:

| Model ID | Uncached input | Output | Cached input | Caveat |
| --- | ---: | ---: | ---: | --- |
| `meta/muse-spark-1.3-contributor` | 0.10 | 0.20 | 0.002 | Data-use opt-in |
| `deepseek/deepseek-v4-flash-0731` | 0.04 | 0.16 | 0.016 | Promising dated coding/agent candidate; pin provider |
| `inception/mercury-2.5` | 0.04 | 0.15 | 0.004 | 260K context; smaller-window admission applies |
| `poolside/laguna-s-2.1` | 0.09 | 0.18 | 0.009 | Coding-focused, 1M context |
| `qwen/qwen3.7-flash` | 0.03 | 0.13 | 0.006 | At 32K input: 0.10/0.40; at 256K: 0.20/0.80 |

These are candidates, not demonstrated DeepSWE substitutes. Prefer testing dated DeepSeek Flash first. Free/batch endpoints and mutable `latest` aliases are excluded. Do not enable them automatically from catalog price alone. Qwen's long-prompt tiers must not be represented as flat cheap rates in this harness's routing estimator; conservatively use the highest relevant tier or leave it outside live routing.

For an additional candidate, add its explicit provider/model configuration under `models.providers`, then a complete routing preset. For OpenRouter use the existing Pi `openrouter` provider or a custom `openai-completions` provider with `baseUrl: https://openrouter.ai/api/v1`, `apiKey: $OPENROUTER_API_KEY`, and `compat.openRouterRouting` containing a reviewed `only` provider list, `allow_fallbacks: false`, and `require_parameters: true`. Freeze that provider's context, supported effort and actual price, not the aggregate model minimum. Add `openrouter.ai` to both arms' network allowlists and forward the key through Pier's `agent.env`.

Meta's [model IDs](https://dev.meta.ai/docs/models), [reasoning support](https://dev.meta.ai/docs/reasoning), and [pricing](https://dev.meta.ai/docs/pricing-rate-limits) are the source for the supplied Muse configuration. Muse does not support reasoning off; lower choices begin at minimal. Contributor tariffs are 0.10/0.20, versus standard 1.25/4.25; both versions share those tier-specific prices. The runner's output cap is an experimental limit, not a guarantee of maximum endpoint output support.

## Protocol

1. Offline checks below, then an explicitly authorized single-task smoke test for each arm. Verify tool calls, completion continuations, agent commits, separate verifier patch collection, credentials/egress, cancellation, saved session and decision coverage. No smoke success has been claimed yet.
2. Select a small development set by repository/language/length before inspecting scores. Save **exact task IDs**. Pier enumerates directories before seeded shuffling; a seed alone does not guarantee portable selection. Keep all tasks from a repository in one split.
3. Run component ablations: completion/recovery, output/retrieval, then context. Remove other component entries in the same manifest for both active arms; unused bindings do not invoke inference. Inspect failures and calibrate on development only.
4. Freeze policies/config, runtime archive SHA, source revision, Pier revision/lock, dataset revision/task checksums, provider endpoint and price snapshot. Run the composed routing-enabled primary comparison on untouched tasks. Both arms start at the same xhigh route and use the same roster, transition graph, cost margin and capability cap.
5. Run the fixed-generator ablation separately by setting routingEnabled to false in both arms. This isolates non-routing decision effects; do not substitute its results for the routing experiment.
6. Use one attempt per task per arm for pass@1, then independent repetitions if budget permits. Counterbalance arm order using separate jobs; the two-arm YAML is a pilot, not an order-randomized study. Do not retry only failures or combine pilot tuning tasks into the held-out headline score.

Primary metric: paired difference in verifier binary reward. Also report pass fractions, tasks won/lost by each controller, task p50/p95 latency, generation/decision requests, abstention/invalid/timeout/admission rejection rates, cache read/write tokens, context reductions and exact-recall calls. Pair by task checksum and repetition, not random trial directory name. Keep infrastructure failures visible; never silently exclude them from one arm.

Suggested pre-registered quality margin: no more than 2 percentage points loss in verified completion. Report a repository-clustered paired confidence interval; if it overlaps unacceptable loss, the conclusion is inconclusive. The small corpus may not establish a tight non-inferiority claim. Cost/latency wins are secondary until quality clears the chosen gate. Final statistical analysis and paid runs are not implemented or performed by this setup.

## Artifacts and accounting

Pier retains its verifier outputs and trial results. Agent logs contain:

- `pi-jev/experiment.json`: resolved experiment and digest.
- `pi-jev/decisions.jsonl`: versioned, timestamped records joined by unique `traceId`. `start` contains the exact projected request (state/history, ordered candidates with descriptions/attributes, current choice), full policy, implementation/version, digests and invocation limits/budget. `provider_result` contains the proposal or abstention, **all candidate scores**, evidence, usage and elapsed time. `end` records the registry's terminal admission/failure, independently of the provider result. `outcome` records the component's actual applied choice or fallback, including stale/cancelled outcomes. Routing outcomes also include cost-guard inputs; context outcomes include the selected plan or cache/compaction fallback. Inputs are private run artifacts, not hashes alone.
- `pi-jev/events.jsonl`: native Pi events, including assistant/tool outputs.
- `pi-jev/sessions/*.jsonl`: original session plus host decision/admission records.
- `pi-jev/summary.json`: persisted session token/cache/cost totals, known decision cost, unknown-cost count, turn cap/failure status, plus routing enablement and host route/phase records (proposals, effective presets, costs, admissions and rejections). Hard termination may leave no summary; events/session remain the diagnostic source.

Jev SDK 0.6.0 reports tokens but no price. Unknown decision cost remains unknown; **Pier cost_usd is deliberately null**, not an understated total. Reconcile provider billing (including reasoning, summaries, cancelled calls, caching, gateway fees and Jev) before claiming an all-in saving. Pi session stats include persisted compaction/summary usage; failed or unpersisted calls may still be billed. Existing metadata does not yet produce a statistically analyzed comparison report.

The adapter reports no ATIF support rather than inventing timestamps or reasoning text. Use native events for analysis; Pier's chat trajectory viewer/critique path is not supported by this adapter yet. Logs can contain source, prompts and sensitive tool output: restrict access, review before sharing, and do not commit run artifacts.

### Decision replay contract

Retain the runtime archive (and its SHA), manifest, native sessions/events and decision log together. To re-evaluate a decision, verify `inputDigest`/`policyDigest`, then invoke the recorded implementation/version with `start.request` and `start.policy` and the recorded limits. No reconstruction from a later session state is needed. To replay admission offline without inference, substitute the recorded `provider_result.result` for the implementation; compare the resulting terminal decision and recorded host outcome. This is decision replay, not a guarantee of byte-identical provider responses or reproduction of external tool side effects. Live re-evaluation remains nondeterministic and requires separate authorization.

Scores use original candidate IDs, not provider labels. Select scores are a distribution; subset/retention scores are independent relevance probabilities. Both arms retain every valid score even when the confidence threshold causes abstention. Missing scores are `null` with a terminal `scoresUnavailableReason` (for example timeout, budget exhaustion or a single-candidate shortcut); they are never fabricated as zero. LLM scores remain self-reported, not calibrated Jev probabilities.

A registry timeout produces a terminal `end` even if the provider is still running. Any later response is a separate `provider_result` with `afterAbort: true`; it cannot overwrite the timeout or execute a stale choice. An implementation exception produces `provider_error` and terminal `end`. A hard process kill can leave an unmatched start. Summary fields `pendingProviderTraceIds`, `missingOutcomeTraceIds` and `traceWriteFailed` expose incomplete coverage at summary time; a write failure fails the trial. Late provider completions may postdate the summary, so reconcile against the append-only log. Reusing an existing run output directory is rejected to prevent mixed traces. No-inference deterministic eligibility checks do not have invented provider scores.

## Setup and commands

No Docker images, provider requests or full benchmark jobs were launched during implementation. The adapter is tested against the pinned Pier source using a fake environment; Linux runtime packaging and full sandbox smoke remain prerequisites.

Use Python >=3.12 and a Docker-capable Linux evaluation host (or Linux containers on this machine). The archived Node binary requires matching architecture, glibc >=2.28 and libstdc++ in the task image. Verify this in the pilot; do not change benchmark images silently.

Clone Pier and DeepSWE separately, checkout the revisions above, and install Pier using its committed `uv.lock` (`uv sync --frozen --no-dev`). No registry download is required. Do not upload the dataset or its `tests`/`solution` directories with the agent runtime.

After reviewing and committing the experiment code, prepare the runtime **from that clean commit**, not a working tree with keys or local data:

```sh
bash scripts/create-source-archive.sh --version 0.85.1 --ref HEAD --out /tmp/pi-jev-source.tar.gz
mkdir -p /tmp/pi-jev-eval-source
tar -xzf /tmp/pi-jev-source.tar.gz -C /tmp/pi-jev-eval-source
docker build --platform linux/amd64 -f evals/deepswe/Dockerfile.runtime -t pi-jev-eval-runtime /tmp/pi-jev-eval-source/pi-0.85.1
docker create --name pi-jev-eval-export pi-jev-eval-runtime
docker cp pi-jev-eval-export:/pi-jev-runtime.tgz /tmp/pi-jev-runtime.tgz
shasum -a 256 /tmp/pi-jev-runtime.tgz
```

The Dockerfile uses `npm ci --ignore-scripts`, the committed npm lock, and Node 22.19.0. Record/pin the resolved base image digest for the final experiment. Runtime source executes through the already-pinned tsx loader with the repo tsconfig; no published upstream Pi package replaces this fork. The export container is left available for inspection; remove it when done.

Plain `git archive` is insufficient: provider JSON data is intentionally ignored by Git. The existing source-archive script adds only that snapshot, validates its hashes, and excludes working-tree secrets. The runtime build checks that snapshot and imports the experiment runner with networking disabled before packaging.

The standalone runner initializes Pi's existing HTTP dispatcher before creating model clients. This makes both LLM and Jev fetch requests honor Pier's authenticated `HTTP_PROXY`/`HTTPS_PROXY` and `NO_PROXY` settings on Node 22.19.0. Do not disable the egress allowlist or TLS verification to fix connection errors. Rebuild the runtime archive after runner changes and record its new SHA; an older archive will still contain the old runner.

Copy the JSON manifest and YAML to a private run directory. Fill the archive absolute path/digest, experiment absolute path and exact task IDs. Set `MODEL_API_KEY` and `TYPESAFE_API_KEY` in the host environment. Both keys are forwarded only by explicit `agent.env`; never print them or enable debug environment logging. The default allowlist is api.meta.ai + api.typesafe.ai. Update it if using a gateway. Then, **only after approving the run budget**:

```sh
PYTHONPATH=/absolute/pi-jev/evals/deepswe uv run --project /absolute/pier --frozen --no-dev pier run --config /absolute/run/pier.yaml
```

For a normal-Pi control, copy an agent entry and change `kwargs.arm` to `control`; preserve initial model, manifest and timeout. Contributor data use is authorized and selected in all seed presets; do not accidentally compare standard billing in one arm to contributor billing in the other.

Offline checks (no provider APIs):

```sh
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/deepswe-experiment.test.ts
```

```sh
PYTHONPATH=/absolute/pi-jev/evals/deepswe uv run --project /absolute/pier --frozen --no-dev python -m unittest discover -s /absolute/pi-jev/evals/deepswe -p 'test_*.py'
npm run check
```
