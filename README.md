<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi-Jev Agent Harness

Pi-Jev is an independent Pi-derived agent harness. It preserves Pi's model loop, tool execution, sessions, compaction, and extension system while using [Jev](https://docs.typesafe.ai) for bounded semantic decisions. Jev advises the harness; deterministic Pi code validates and applies every decision.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## Jev integration

`jev.mode: "decisions"` enables a shared decision library with configurable implementations and policies. The normal CLI and default SDK startup install the configured components after settings and project trust are resolved. Everything is opt-in. See the [architecture decisions](docs/adr/README.md), [implementation log](docs/jev-implementation-log.md), and [experiment checklist](docs/jev-experiments.md).

Jev replaces selected **judgments**, not the execution engine. Pi still builds prompts, calls the selected model, validates tool arguments, executes tools, stores sessions and performs compaction. A Jev proposal cannot grant permissions or invent an available model/tool.

### What changes when enabled

| Component | Decision and integration point | Disabled behavior |
|---|---|---|
| Routing | Select a complete model, reasoning-effort and tool preset in `before_generation`, before prompt/schema assembly; use private harness state and deterministic cache-cost admission | Keep the current configuration |
| Phase classification | Classify newly settled tool-result boundaries against configured allowed transitions; only an admitted phase change permits another route decision | Explicit `/decision-phase <name>` transitions only |
| Skills | Select visibility from loaded skill descriptions before route pricing and prompt assembly; retain explicit requests and pin selection within the phase | Normal loaded-skill visibility |
| Retrieval | Select grouped hits from settled built-in `grep`/`find` output; preserve required hits and exact originals | Return original search results |
| Output | Select blocks from configured tools' fresh text output; preserve errors, protected evidence and exact originals | Return original tool output |
| Tool review | Review a proposed call and optionally block it before execution; `request_review` blocks with an explanation, not an approval dialog | Existing tool-call path |
| Completion | Inspect the final result and recent evidence; request bounded verification or clarification through the existing follow-up queue | End the run normally |
| Context | Score historical tool calls/results and select a recoverable view within an estimated budget **before prompt construction**; optional cache-aware reuse; selection also precedes manual/overflow compaction | Existing Pi context and summarization |
| Recovery | Classify failed configured tools as `continue`, `inspect` or `clarify`; append fixed guidance without replaying the action | Original error result |
| Evidence | `verify_evidence` judges a claim against existing successful text tool-result IDs: `supports`, `contradicts`, `insufficient` | No evidence-classification tool |
| Specialists | `consult_specialist` selects an approved model/effort/instruction preset for one isolated, tool-free consultation | No specialist tool |

Routing and skill selection share one phase owner. Ordinary turns and retries do not trigger model switching. Model, effort and tools commit together in memory after authorization/freshness checks; later user or extension changes take precedence. This is not a transactional disk commit. See [ADR 2](docs/adr/0002-phase-boundaries-and-host-authority.md).

Repeating `/decision-phase` with the current phase is a no-op. Cache admission compares a favorable stay estimate against an all-cold target estimate across the configured horizon; hypothetical target cache hits cannot justify switching. Tool/effort changes are conservatively treated as cache-breaking. Prices come from the model registry; expected work, classifier overhead and margins remain operator-supplied estimates, not guaranteed savings. Smaller-window candidates require enabled context management and a preliminary feasibility floor. Context selection then checks the selected model's estimated budget before prompt construction.

### Runtime modes

| Mode | Behavior |
|---|---|
| `off` | Default. No decision inference or routing. Local recall remains available on resumed branches containing previously reduced output. |
| `decisions` | Shared registry, phase/cache-aware routing and individually enabled components. Baseline/heuristic implementations need no Jev key. |
| `route` | Migration alias for `decisions` when `jev.decisions` is supplied. Old partial profiles alone no longer route; with a key they report a migration warning. |

### Start with routing, without remote decisions

Set `~/.pi/agent/settings.json` or trusted project-local `.pi/settings.json`. This baseline exercises the integration but deliberately keeps the current configuration. Replace the provider/model placeholders with an authenticated model from your registry. Each preset supplies all three choices; omitted tools are not inherited.

```json
{
  "jev": {
    "mode": "decisions",
    "decisions": {
      "routing": {
        "binding": { "implementation": "baseline.keep-current", "policy": {} },
        "phases": ["investigate", "implement", "verify"],
        "requiredTools": ["read"],
        "routes": [{
          "id": "approved-low",
          "description": "Approved model with low reasoning",
          "provider": "YOUR_PROVIDER",
          "model": "YOUR_MODEL",
          "effort": "low",
          "tools": ["read", "grep", "find", "bash", "edit", "write"]
        }],
        "timeoutMs": 5000,
        "maxDecisions": 100,
        "estimate": {
          "requests": 3,
          "outputTokens": 4000,
          "marginUsd": 0.01,
          "decisionCostUsd": 0.001
        }
      }
    }
  }
}
```

Those numeric estimates are examples to calibrate, not recommended tariffs. An economic switch must clear `marginUsd`. Optional `routing.escalationMaxUsd` permits a non-saving capability switch under a known estimated cost cap. Unknown economics do not establish savings. Unsupported effort, missing auth/tools, scoped-model restrictions, cancellation or stale state prevent application.

### Enable Jev and individual components

Set `TYPESAFE_API_KEY` in the process environment. Add the following fields **inside `jev.decisions`**, alongside the routing configuration above. Relative package paths resolve against the session working directory. The [sample policy package](packages/decisions/examples/policies/manifest.json) is editable JSON; copy it for your own versioned policies.

```json
{
  "policyPackages": ["packages/decisions/examples/policies"],
  "policyReferences": {
    "generation.route/v1": "example/routing@1",
    "generation.phase/v1": "example/phases@1",
    "skills.select/v1": "example/skills@1",
    "retrieval.rank/v1": "example/retrieval@1",
    "output.select/v1": "example/output@1",
    "tools.review/v1": "example/review@1",
    "completion.verify/v1": "example/completion@1"
  },
  "components": {
    "skills": true,
    "retrieval": { "minChars": 2000, "maxChars": 20000, "minReduction": 0.2 },
    "output": { "tools": ["bash"], "minChars": 4000, "maxChars": 20000, "blockLines": 20, "minReduction": 0.2 },
    "review": { "tools": ["bash", "edit", "write"], "onFailure": "block" },
    "completion": {
      "maxPasses": 1,
      "followUps": {
        "verify": "Verify the claimed result and report unresolved failed checks.",
        "clarify": "Ask for the missing information or authority required to finish."
      }
    }
  },
  "timeoutMs": 5000,
  "maxComponentDecisions": 100
}
```

When enabling output or retrieval with routing, add `recall_output` to **both** `routing.requiredTools` and **every** preset's `tools`. The extension registers it; the model can then recover exact original output. Retrieval takes precedence over generic output selection for `grep`/`find`; truncated search results are left unchanged. Neither component selectively compacts transcript history.

For the phase binding above, also add these fields to `routing`:

```json
{
  "transitions": { "investigate": ["implement"], "implement": ["verify"], "verify": ["implement"] },
  "phaseDescriptions": {
    "investigate": "Gather evidence and identify the change.",
    "implement": "Make the authorized change.",
    "verify": "Check the result against acceptance criteria."
  },
  "maxPhaseDecisions": 30
}
```

References override inline `bindings` and routing bindings. Enabled components require matching bindings; skills also require routing. Invalid bundles are disabled together with a startup warning. A missing Jev key cannot silently substitute another implementation. Review failures obey `onFailure`; other failed selections retain existing content/configuration, except observed unresolved tool failures can still request bounded completion verification.

### Enable context management

This standalone configuration needs `TYPESAFE_API_KEY`, but does not require routing:

```json
{
  "jev": {
    "mode": "decisions",
    "decisions": {
      "policyPackages": ["packages/decisions/examples/policies"],
      "policyReferences": { "context.retention/v1": "example/context@1" },
      "components": {
        "context": {
          "cacheAware": true,
          "cacheExpectedRequests": 3,
          "cacheMinSavingsUsd": 0,
          "safetyMarginTokens": 2048,
          "triggerRatio": 0.9,
          "targetRatio": 0.75,
          "keepThreshold": 0.3,
          "preserveRecentMessages": 6,
          "excerptChars": 1200,
          "recallMaxChars": 4000
        }
      }
    }
  }
}
```

With routing, add `recall_context` to `routing.requiredTools` and every preset's `tools`. For a network-free retain-all baseline, replace `policyPackages`/`policyReferences` with `"bindings": { "context.retention/v1": { "implementation": "baseline.keep-current", "policy": {} } }`. That baseline still permits ordinary summarization when selection cannot reduce context.

The classifier sees a bounded ordered conversation overview, call inputs, result head/tail excerpts and private task/phase/model state. It scores whether the call and result remain needed separately. A needed result keeps both; a needed call keeps its input and an exact head/tail result excerpt; otherwise the complete pair is omitted. Unjudged items stay. User/assistant text, errors, multimodal results, recent messages and recall results are protected. The selector does not rewrite dialogue or claim a globally optimal subset.

The order is `private state/context requirements → model/effort/tools → context selection and estimated-budget admission → prompt construction → provider`. There is one selection/admission boundary, not another decision after rendering. Skills and retrieval retain their existing selection mechanisms; context management selects historical tool evidence, not arbitrary system instructions.

Selection projects the request without deleting session history. `recall_context` without an ID lists available original tool-result IDs; with `toolCallId`, it returns bounded text using `offset`/`maxChars`.

With `cacheAware: true` (default), a valid branch-local plan is reused below `triggerRatio`. Task, phase, model, effort, tools, prompt configuration or failure changes invalidate reuse. Under pressure, a new proposal may be deferred if the existing view still fits and rewriting its cached prefix is estimated to cost more than the saved input over `cacheExpectedRequests`. This arithmetic uses observed same-model cache reads, the estimated unchanged prefix and registry prices; `cacheMinSavingsUsd` sets the required saving. It never preserves an oversized view or overrides a changed-task/manual/overflow decision. Unknown cache economics do not block the relevance proposal. This is a cost estimate, not a cache-hit guarantee.

To disable cache-aware selection while keeping relevance selection enabled, set:

```json
{ "components": { "context": { "cacheAware": false } } }
```

Place that under `jev.decisions`, keeping the context binding above. With cache awareness off, eligible evidence is re-evaluated at every preparation boundary, even below the pressure trigger; persisted plans and rewrite-cost preference are bypassed. The same retention threshold, protected evidence, request limits, exact recall and summary fallback apply. This can spend more decision calls and invalidate more provider cache prefixes. It does not disable provider caching or the separate routing cost checks.

Input capacity subtracts the host/model output reservation and `safetyMarginTokens`; `reserveOutputTokens` can raise the reservation. Pre-construction admission counts source messages/tool declarations plus estimated overhead from raw prompt configuration. It uses a UTF-8-size heuristic, **not an exact provider tokenizer**. `targetRatio` is a soft target; the estimated capacity is enforced. Insufficient selection falls back to existing Pi summarization once and re-plans before building the prompt. Oversized protected content stops preparation rather than being silently deleted.

There is deliberately **no post-construction generation capacity gate**. Rendered overhead, late steering messages and trusted extension/payload edits can exceed the estimate; ordinary provider overflow recovery remains the fallback. Late input stays intact. Separately, every history, split-turn and branch summarization request now checks serialized UTF-8 size/3 plus output reservation and a 5% context margin (minimum 256 tokens) before provider execution. Oversized summaries fail without discarding history. Neither estimate is an exact tokenizer. [ADR 4](docs/adr/0004-context-window-management.md) explains the tradeoffs; [ADR 5](docs/adr/0005-decision-responsibility-map.md) maps responsibilities.

Optional limits are `stateChars` (48000), `requestChars` (80000), `maxRequests` (8), `concurrency` (2), and `minReduction` (0.1). These are bounded projection/request estimates, not a tokenizer guarantee for Jev. Context batches share `maxComponentDecisions` with other configured components. Rubrics and these numerical settings are configurable for offline calibration; `keepThreshold` applies raw scores, not the adapter's selection-only `minProbability`. See [ADR 4](docs/adr/0004-context-window-management.md).

Disable this component by removing `components.context` and restarting/reloading. Projection stops; the original session remains available, and branches with prior plans retain local recall even in `off` mode. Earlier ordinary summary entries are not undone.

### Disable and reload

Disable all new decisions:

```json
{ "jev": { "mode": "off" } }
```

Disable individual components by removing their key from `components`; `"skills": false` also disables skills. For example, `"components": { "review": { "tools": ["bash"], "onFailure": "block" } }` enables only review. Remove `routing` (and disable skills) to run components without routing. To disable automatic phase classification, remove its `policyReferences`/`bindings` entry and any inline `routing.phaseBinding`; explicit phase commands still work.

Restart or use normal resource reload after settings changes. Reload resolves trusted settings again; it is not a filesystem watcher or automatic optimizer promotion. Existing phase records prevent another routing decision within the same phase. Turning decisions off stops new decisions, but does not undo an already selected model/tool preset or rewrite saved output. Select your desired model/tools normally; `recall_output` remains local and branch-scoped for saved originals, subject to host tool restrictions.

Migrate legacy `jev.routes` to complete `jev.decisions.routing.routes` presets; partial profiles are not applied. Removed `shadow` mode does not make Jev calls.

### Reuse the library or supply a plugin

[`@earendil-works/pi-decisions`](packages/decisions/src/index.ts) contains the contracts, registry, policy loading and built-in baseline/weighted/recorded implementations. `/jev` supplies an injected Jev transport; `/evaluation` and `/learning` supply offline comparison and artifact conversion. Importing the core does not load Jev or read credentials.

For a trusted host, inject another `DecisionImplementation` without changing harness adapters:

```ts
import { createConfiguredDecisionExtension } from "@earendil-works/pi-coding-agent/jev";
import type { DecisionImplementation } from "@earendil-works/pi-decisions";

const implementation: DecisionImplementation = {
  id: "team.current",
  version: "1",
  definitions: ["generation.route/v1"],
  async evaluate(request) {
    return request.currentCandidateId
      ? { status: "proposed", answer: { kind: "select", candidateId: request.currentCandidateId } }
      : { status: "abstained", reason: "no-current-candidate" };
  }
};

// settings is your DecisionSettings object; set its routing binding to team.current.
const decisionExtension = createConfiguredDecisionExtension(settings, { implementations: [implementation] });
// Supply decisionExtension through your resource loader's inline extension factories.
```

Use one installation path: the configured built-in integration, or your extension supplying that integration. JSON policy packages contain data, not executable module paths. Executable plugins use the existing trusted Pi extension loader; they are not sandboxed. See [ADR 1](docs/adr/0001-reusable-decisions-and-policy-plugins.md).

Custom SDK resource loaders own their extensions. With `DefaultResourceLoader`, use `finalExtensionFactories: () => createConfiguredJevExtensions(settingsManager.getJevSettings(), cwd)` from `@earendil-works/pi-coding-agent/jev` to get the same post-trust behavior. Ordinary `createAgentSession()` and CLI startup already do this.

Low-level `AgentHarness` applications use [`createDecisionGenerationRouter`](packages/coding-agent/src/jev/decision-durable.ts) with their private snapshot, candidate roster and admission callback. Pass an existing disk-backed `SessionManager` as `persistence` and a stable admitted phase identity as `request.boundaryId`: reservations pin that lane/phase across adapter restarts, including interrupted decisions, and record policy/roster digests and invocation metadata. The driver still checkpoints the applied configuration. Hosts must use the correct session branch and ignore decision audit entries in freshness checks; omitting `persistence` leaves this responsibility with the host. Custom retrieval backends use [`selectRetrievedContext`](packages/coding-agent/src/jev/decision-selection.ts).

### Learn policies, not authority

Instructions, criteria, probability thresholds, heuristic weights and phase descriptions are data. Compare implementations on identical frozen requests, export consented/redacted training data to jev-align/GEPA, import an accepted definition as a new policy version, then evaluate it on held-out task groups before promotion. Model/tool authority, input validation, required evidence and evaluation/spending gates remain host-owned. See [ADR 3](docs/adr/0003-evidence-and-offline-learning.md).

`policyDigests` optionally pins reviewed SHA-256 artifact digests by `id@version` across restarts. The offline promotion helpers do not attest their own evaluation reports or change live settings. Run the synthetic, network-free workflow from the repository root:

```sh
node --experimental-strip-types packages/decisions/examples/learning-roundtrip.ts
```

Decision traces are metadata-only by default, but inference receives bounded task/tool text, and exact output recovery stores originals in the local session. These are not automatic secret redaction. Replay capture requires separate consent and redaction. Synthetic checks validate plumbing, not Jev quality, savings or GEPA effectiveness.

### Recovery, evidence and specialist configuration

See [workflow configuration and limits](docs/jev-workflows.md) and [ADR 6](docs/adr/0006-bounded-workflows-and-gap-closure.md) for complete examples. Each workflow requires its matching binding and component setting. Baseline implementations make no Jev calls: recovery continues unchanged, evidence returns `insufficient`, and specialists select `none`. Switching that binding to `jev.typed` enables finite semantic selection.

Evidence and specialist tools accept `{ "task": "claim or subtask", "sourceIds": ["existing-tool-call-id"] }`. They reject unknown, failed, non-text and classifier/consultation sources. Specialist execution is one bounded provider request with no child tools, no recursion and no main-route change. Workflow allowances are reserved on the branch before inference. Add enabled tool names to routing presets that should expose them.

Component and skill records now retain implementation/version, input/policy digests, elapsed time, request/token counts and reported cost. Unknown tokens/cost remain `null`. Inputs/provider evidence are excluded from these metadata records; originals remain local session content.

Arbitrary dialogue pruning and autonomous tool-using specialist trees remain outside this implementation. Evidence labels and specialist prose are advisory, not verified facts. Provider-backed experiments and optimizer runs remain explicit [TODOs](docs/jev-experiments.md).

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-decisions](packages/decisions)** | Reusable decisions, policy packages, offline comparison and learning bridge |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
