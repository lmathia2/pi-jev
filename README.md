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

The normal coding-agent startup path reads Jev settings and installs a provider-neutral generation-routing component. The component has two implementations:

- the default provider returns no override, preserving ordinary Pi behavior;
- the Jev provider classifies the task as `fast`, `standard`, `deep`, or `research`, then maps the selected route to an explicitly configured model, thinking level, and tool allowlist.

Jev never generates tool arguments, executes tools, grants permissions, or bypasses Pi's model and tool registries.

### Runtime modes

| Mode | Behavior |
|---|---|
| `off` | Default. No Jev client or routing extension is created. |
| `shadow` | Starts the Jev request asynchronously and records its result without delaying or changing the main path. |
| `route` | Waits for a validated Jev decision and applies the configured route profile before the agent run. |

Set `TYPESAFE_API_KEY` in the environment, then configure `~/.pi/agent/settings.json` or project-local `.pi/settings.json`:

```json
{
  "jev": {
    "mode": "route",
    "timeoutMs": 5000,
    "minProbability": 0.7,
    "minFit": 0.7,
    "routes": {
      "fast": { "thinkingLevel": "low", "tools": ["read", "grep"] },
      "standard": { "thinkingLevel": "medium" },
      "deep": { "thinkingLevel": "high" },
      "research": { "thinkingLevel": "high", "tools": ["read", "grep"] }
    }
  }
}
```

A route may also set `provider` and `model` together. Unknown routes, unavailable models or tools, missing authentication, low probability or fit, timeouts, rate limits, malformed responses, and provider errors all preserve the current Pi configuration.

### Decision points in the code

| Decision point | Code | Runtime status | Default behavior |
|---|---|---|---|
| Generation route | [`generation-routing.ts`](packages/coding-agent/src/core/generation-routing.ts), [`runtime.ts`](packages/coding-agent/src/jev/runtime.ts) | Automatically wired into normal session startup according to `jev.mode` | Keep the current model, thinking level, and tools |
| Durable pre-generation route | [`generation-router.ts`](packages/coding-agent/src/jev/generation-router.ts) | Available to low-level `AgentHarness` hosts | Return no generation patch |
| Skill, tool, or specialist selection | [`selectJevCandidate`](packages/coding-agent/src/jev/client.ts) | Available to callers with a bounded candidate list | Keep the caller's existing selection path |
| Context selection | [`selectJevContext`](packages/coding-agent/src/jev/context-selector.ts) | Available to retrieval and `transform_context` integrations | Return all original context IDs |
| Shadow evaluation | [`shadow.ts`](packages/coding-agent/src/jev/shadow.ts) | Available separately; configured runtime shadow uses the shared routing component | Observe only; never mutate execution |

Routing writes privacy-safe `generation-route` session entries containing the turn, selected route, probability, fit, applied profile, or fallback reason. It does not store the task prompt, repository contents, tool output, or API key.

Checkpoint control and selective compaction are intentionally not active. The existing Pi loop and compaction remain authoritative until offline evaluation justifies those changes. See [`docs/jev-harness.md`](docs/jev-harness.md) for assumptions, invariants, implementation status, and deferred work.

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
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
