import argparse
import json
import subprocess
from pathlib import Path

from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

from route import load_api_key


QUESTIONS = {"choice": Choice, "noul": Noul, "score": Score}


def enabled(step: dict, results: dict) -> bool:
    return all(results.get(name, {}).get("value") == value for name, value in step.get("when", {}).items())


def answer_data(answer) -> dict:
    for field in ("choice", "noul", "score"):
        if hasattr(answer, field):
            data = {"value": getattr(answer, field)}
            break
    if hasattr(answer, "confidence"):
        data["confidence"] = answer.confidence
    if hasattr(answer, "probabilities"):
        data["probabilities"] = answer.probabilities
    return data


def run(path: Path, input_text: str) -> dict:
    workflow = json.loads(path.read_text())
    state = {**workflow.get("state", {}), "input": input_text}
    results = {}
    load_api_key()

    steps = workflow["steps"]
    with TypeSafeClient() as client:
        index = 0
        while index < len(steps):
            step = steps[index]
            if not enabled(step, results):
                results[step["id"]] = {"skipped": True}
                index += 1
                continue

            kind = step["type"]
            if kind in QUESTIONS:
                batch = []
                while index < len(steps) and steps[index]["type"] in QUESTIONS and not steps[index].get("when"):
                    batch.append(steps[index])
                    index += 1
                if not batch:  # This question depends on an earlier result.
                    batch = [step]
                    index += 1
                questions = {}
                for question in batch:
                    kwargs = {"instructions": question["instructions"]}
                    if "criteria" in question:
                        kwargs["criteria"] = question["criteria"]
                    questions[question["id"]] = QUESTIONS[question["type"]](**kwargs)
                response = client.system_one(
                    state={**state, "results": results},
                    questions=questions,
                )
                for question in batch:
                    name = question["id"]
                    results[name] = answer_data(response.answers[name])
            elif kind == "command":
                completed = subprocess.run(step["argv"], text=True, capture_output=True)
                results[step["id"]] = {
                    "value": completed.returncode,
                    "stdout": completed.stdout,
                    "stderr": completed.stderr,
                }
                if completed.returncode and not step.get("continue_on_error"):
                    break
                index += 1
            else:
                raise ValueError(f"Unknown step type: {kind}")

    return results


def self_check(path: Path) -> None:
    workflow = json.loads(path.read_text())
    ids = [step["id"] for step in workflow["steps"]]
    assert len(ids) == len(set(ids))
    assert all(step["type"] in {*QUESTIONS, "command"} for step in workflow["steps"])
    assert all(set(step.get("when", {})) <= set(ids[:i]) for i, step in enumerate(workflow["steps"]))
    assert all(step.get("type") != "command" or isinstance(step.get("argv"), list) for step in workflow["steps"])
    print(f"ok: {len(ids)} workflow steps")


def main() -> None:
    parser = argparse.ArgumentParser(description="Tiny deterministic workflow runner with typed Jev steps.")
    parser.add_argument("workflow", type=Path)
    parser.add_argument("input", nargs="?", default="")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        self_check(args.workflow)
        return
    print(json.dumps(run(args.workflow, args.input), indent=2))


if __name__ == "__main__":
    main()
