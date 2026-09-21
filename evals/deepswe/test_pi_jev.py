import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import yaml
from pier.models.agent.context import AgentContext
from pier.models.job.config import JobConfig
from pi_jev import PiJev


class AdapterTest(unittest.IsolatedAsyncioTestCase):
    def test_job_config_matches_pier_schema(self):
        config = JobConfig.model_validate(yaml.safe_load(Path(__file__).with_name("pier.yaml").read_text()))
        self.assertEqual([agent.kwargs["arm"] for agent in config.agents], ["llm", "jev"])
        self.assertEqual(config.agents[0].model_name, "meta/muse-spark-1.3-contributor")
        self.assertEqual(config.agents[0].kwargs | {"arm": "jev"}, config.agents[1].kwargs)
        self.assertFalse(config.verifier.disable)
        self.assertEqual(config.retry.max_retries, 0)

    async def test_adapter_quotes_instruction_and_preserves_unknown_cost(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "runtime.tgz"
            archive.write_bytes(b"offline fixture")
            manifest = root / "experiment.json"
            manifest.write_text(json.dumps({"generator": {"provider": "meta", "model": "muse-spark-1.3"}}))
            kwargs = dict(logs_dir=root, model_name="meta/muse-spark-1.3",
                          runtime_archive=archive, runtime_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                          experiment=manifest, arm="jev", domains=["api.meta.ai"],
                          extra_env={"TYPESAFE_API_KEY": "test-only"})
            agent = PiJev(**kwargs)
            self.assertEqual(agent.network_allowlist().domains, ["api.meta.ai"])
            environment = AsyncMock()
            environment.agent_process_env = lambda env: env
            environment.exec.return_value.return_code = 0
            await agent.run("task ' $(do-not-execute)\nnext", environment, AgentContext())
            command = environment.exec.call_args.kwargs["command"]
            self.assertNotIn("do-not-execute", command)
            self.assertNotIn("test-only", command)
            context = AgentContext()
            agent.populate_context_post_run(context)
            self.assertTrue(context.metadata["incomplete"])
            output = root / "pi-jev"
            output.mkdir()
            (output / "summary.json").write_text(json.dumps({
                "generator": {"tokens": {"input": 10, "cacheRead": 20, "cacheWrite": 5, "output": 3}},
                "unknownDecisionCosts": 1,
            }))
            agent.populate_context_post_run(context)
            self.assertEqual(context.n_input_tokens, 35)
            self.assertIsNone(context.cost_usd)
            with self.assertRaises(ValueError):
                PiJev(**{**kwargs, "runtime_sha256": "0" * 64})
            with self.assertRaises(ValueError):
                PiJev(**{**kwargs, "model_name": "wrong/model"})
            with self.assertRaises(ValueError):
                PiJev(**{**kwargs, "arm": "shadow"})


if __name__ == "__main__":
    unittest.main()
