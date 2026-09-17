import argparse
import csv
import statistics
import time
from pathlib import Path

from typesafe_sdk import Choice, TypeSafeClient

from route import load_api_key


CASES = [
    ("Open pricing", ["Docs", "Pricing", "Log in", "Blog", "Careers"], 1),
    ("Search for a flight", ["From", "To", "Search flights", "One way", "Passengers"], 2),
    ("Enter the destination city", ["Departure airport", "Destination airport", "Travel date", "Search", "Cabin"], 1),
    ("Continue to checkout", ["Keep shopping", "Remove", "Apply coupon", "Checkout", "Quantity"], 3),
    ("Download the invoice", ["Back", "Print receipt", "Download invoice", "Contact support", "Refund"], 2),
    ("Accept the cookie settings", ["Reject all", "Preferences", "Accept all", "Privacy policy", "Close"], 2),
    ("Create a new project", ["Import", "New project", "Templates", "Settings", "Help"], 1),
    ("Sign out of the account", ["Profile", "Billing", "Security", "Sign out", "Team"], 3),
    ("Filter results by newest", ["Relevance", "Price", "Newest", "Rating", "Clear filters"], 2),
    ("Send the completed message", ["Attach", "Discard", "Save draft", "Send", "Schedule"], 3),
    ("Open accessibility settings", ["Appearance", "Notifications", "Accessibility", "Language", "Account"], 2),
    ("Go back to the previous page", ["Reload", "Forward", "Back", "Home", "Bookmarks"], 2),
    ("Add this item to favorites", ["Share", "Compare", "Favorite", "Add to cart", "Details"], 2),
    ("Select business class", ["Economy", "Premium economy", "Business", "First", "Flexible dates"], 2),
    ("View the full documentation", ["Quickstart", "API reference", "Examples", "Full documentation", "Changelog"], 3),
    ("Cancel editing without saving", ["Save", "Preview", "Cancel", "Publish", "History"], 2),
    ("Invite a teammate", ["Members", "Roles", "Invite member", "Audit log", "Permissions"], 2),
    ("Expand advanced options", ["Basic", "Reset", "Advanced options", "Apply", "Close"], 2),
    ("Play the demonstration video", ["Transcript", "Share", "Play video", "Captions", "Fullscreen"], 2),
    ("Return to the dashboard", ["Reports", "Dashboard", "Export", "Settings", "Support"], 1),
]


def percentile(values: list[float], fraction: float) -> float:
    return sorted(values)[round((len(values) - 1) * fraction)]


def jev(limit: int) -> list[dict]:
    load_api_key()
    rows = []
    with TypeSafeClient() as client:
        for task, labels, expected in CASES[:limit]:
            started = time.perf_counter()
            response = client.system_one(
                state={"task": task, "elements": dict(enumerate(labels))},
                questions={"target": Choice(
                    instructions="Which `elements` id should be activated to complete `task`?",
                    criteria={str(i): label for i, label in enumerate(labels)},
                )},
            )
            answer = response.answers["target"]
            rows.append({
                "backend": "jev", "task": task, "expected": expected,
                "predicted": int(answer.choice), "confidence": answer.confidence,
                "latency_ms": (time.perf_counter() - started) * 1000,
                "input_tokens": response.usage.input_tokens or 0,
            })
    return rows


def gliner(limit: int, model_name: str) -> tuple[list[dict], float]:
    try:
        from gliner2 import AutoExtractor
    except ImportError as error:
        raise SystemExit("Install the local backend with: uv sync --extra gliner") from error
    started = time.perf_counter()
    model = AutoExtractor.from_pretrained(model_name)
    load_ms = (time.perf_counter() - started) * 1000
    rows = []
    for task, labels, expected in CASES[:limit]:
        schema = model.create_schema().classification("target", {str(i): label for i, label in enumerate(labels)})
        started = time.perf_counter()
        result = model.extract(task, schema, include_confidence=True)["target"]
        rows.append({
            "backend": "gliner", "task": task, "expected": expected,
            "predicted": int(result["label"]), "confidence": result["confidence"],
            "latency_ms": (time.perf_counter() - started) * 1000, "input_tokens": 0,
        })
    return rows, load_ms


def summarize(rows: list[dict], load_ms: float = 0) -> None:
    latencies = [row["latency_ms"] for row in rows]
    correct = sum(row["predicted"] == row["expected"] for row in rows)
    tokens = sum(row["input_tokens"] for row in rows)
    cost = tokens * 42 / 1_000_000_000
    print(f'{rows[0]["backend"]}: {correct}/{len(rows)} ({correct / len(rows):.1%}) | '
          f'p50 {statistics.median(latencies):.1f}ms | p95 {percentile(latencies, .95):.1f}ms | '
          f'load {load_ms:.1f}ms | tokens {tokens} | marginal cost ${cost:.6f}')


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark Jev and local GLiNER2.5 on browser target selection.")
    parser.add_argument("--backend", choices=("both", "jev", "gliner"), default="both")
    parser.add_argument("--limit", type=int, default=len(CASES))
    parser.add_argument("--model", default="fastino/gliner2.5-small-v1")
    parser.add_argument("--output", type=Path, default=Path("benchmark_results.csv"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    assert 0 < args.limit <= len(CASES)
    assert all(0 <= expected < len(labels) and len(labels) == len(set(labels)) for _, labels, expected in CASES)
    if args.check:
        print(f"ok: {len(CASES)} browser target-selection cases")
        return

    rows = []
    if args.backend in ("both", "jev"):
        jev_rows = jev(args.limit)
        rows += jev_rows
        summarize(jev_rows)
    if args.backend in ("both", "gliner"):
        gliner_rows, load_ms = gliner(args.limit, args.model)
        rows += gliner_rows
        summarize(gliner_rows, load_ms)
    with args.output.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=rows[0])
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
