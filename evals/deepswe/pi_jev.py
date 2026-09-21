"""Pier installed-agent adapter. No provider calls on the host; no task uploads."""

import hashlib
import json
import re
import shlex
import tempfile
from pathlib import Path

from pier.agents.installed.base import BaseInstalledAgent
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist


class PiJev(BaseInstalledAgent):
    # Keep native Pi events/sessions; do not fabricate an ATIF trajectory.
    SUPPORTS_ATIF = False

    def __init__(self, *, runtime_archive, runtime_sha256, experiment, arm,
                 domains, **kwargs):
        super().__init__(**kwargs)
        if arm not in {"control", "llm", "jev"}:
            raise ValueError("Invalid arm")
        if not re.fullmatch(r"[0-9a-f]{64}", runtime_sha256):
            raise ValueError("Pin the runtime archive SHA-256")
        self.archive = Path(runtime_archive).resolve()
        with self.archive.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != runtime_sha256:
                raise ValueError("Runtime archive digest mismatch")
        self.experiment = Path(experiment).resolve()
        config = json.loads(self.experiment.read_text())
        generator = config["generator"]
        if self.model_name != f"{generator['provider']}/{generator['model']}":
            raise ValueError("Pier model_name must match experiment generator")
        self.arm = arm
        self.digest = runtime_sha256
        self.allowlist = NetworkAllowlist(domains=domains)
        if not self.allowlist.domains:
            raise ValueError("Explicit inference domain allowlist required")

    @staticmethod
    def name():
        return "pi-jev"

    def version(self):
        return self.digest

    def network_allowlist(self):
        return self.allowlist

    def install_spec(self):
        # Runtime is prepared once on Linux, then uploaded offline to each task.
        return AgentInstallSpec(agent_name=self.name(), version=self.digest,
                                steps=[InstallStep(run="true")])

    async def setup(self, environment):
        await super().setup(environment)
        await environment.upload_file(self.archive, "/tmp/pi-jev-runtime.tgz")
        result = await environment.exec(
            command="mkdir -p /installed-agent/pi-jev && tar -xzf /tmp/pi-jev-runtime.tgz -C /installed-agent/pi-jev && chmod -R a+rX /installed-agent/pi-jev && /installed-agent/pi-jev/node --version",
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError("Cannot unpack or execute the Linux runtime")
        await environment.upload_file(self.experiment, "/installed-agent/pi-jev-experiment.json")

    async def run(self, instruction, environment, context):
        with tempfile.TemporaryDirectory(prefix="pi-jev-instruction-") as directory:
            path = Path(directory) / "instruction.txt"
            path.write_text(self.render_instruction(instruction))
            await environment.upload_file(path, "/tmp/pi-jev-instruction.txt")
        root = "/installed-agent/pi-jev"
        env = self.build_process_env({"TSX_TSCONFIG_PATH": f"{root}/tsconfig.json"})
        result = await environment.exec(
            command=shlex.join([
                f"{root}/node", "--import", f"{root}/node_modules/tsx/dist/loader.mjs",
                f"{root}/packages/coding-agent/examples/deepswe/run.ts",
                "/installed-agent/pi-jev-experiment.json", self.arm,
                "/tmp/pi-jev-instruction.txt", "/logs/agent/pi-jev",
            ]) + " > /logs/agent/pi-jev.stdout 2> /logs/agent/pi-jev.stderr",
            env=environment.agent_process_env(env),
        )
        if result.return_code != 0:
            raise RuntimeError(f"pi-jev exited {result.return_code}; see agent logs")

    def populate_context_post_run(self, context):
        path = self.logs_dir / "pi-jev" / "summary.json"
        if not path.exists():
            context.metadata = {"arm": self.arm, "incomplete": True}
            return
        summary = json.loads(path.read_text())
        tokens = summary["generator"]["tokens"]
        context.n_input_tokens = tokens["input"] + tokens["cacheRead"] + tokens["cacheWrite"]
        context.n_cache_tokens = tokens["cacheRead"]
        context.n_output_tokens = tokens["output"]
        # These are generator counters, not falsely comparable combined LLM/Jev totals.
        context.cost_usd = None
        context.metadata = summary
