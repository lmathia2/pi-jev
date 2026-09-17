# Jev agent-task router

An 80-example labeled evaluation of one Jev `Choice` question across eight routes.

Latest run: **78/80 (97.5%)**, with 0.907 mean confidence. Both disagreements are
reasonable boundary cases between standalone writing and person-to-person communication;
see `results.csv` for every prediction and probability-derived confidence score.

```sh
uv run route.py --check
uv run route.py              # classify all 80 and write results.csv
uv run route.py --limit 10   # cheap smoke run
```

The script reads `TYPESAFE_API_KEY` or `JEV_API_KEY`; it also recognizes `JEV_API_KEY` in `~/.env`.

## Browser-use prototype

`browse.py` reproduces the observe → Jev decision → confidence gate → browser action loop with Playwright and the installed Chrome:

```sh
uv run browse.py https://example.com "click More information"
uv run browse.py https://example.com "search for Jev" --value Jev --headed
uv run browse.py --check
```

Text is supplied explicitly with `--value`; Jev selects whether and where to enter it, but never generates arbitrary input or bypasses the confidence gate.

## Jev vs local GLiNER2.5

The benchmark gives both models the same task and candidate browser elements, then measures target-selection accuracy and latency:

```sh
uv sync --extra gliner
uv run benchmark.py
uv run benchmark.py --check
```

GLiNER model load time is reported separately. Jev cost uses its current $42/billion-input-token price; local GLiNER marginal inference cost is reported as zero, excluding hardware and electricity.

## Structured workflows

`flow.py` is the smallest useful Roast-like core: JSON defines typed Jev judgments,
exact branch conditions, and shell-free command steps; Python owns execution.

```sh
uv run flow.py example-flow.json --check
uv run flow.py example-flow.json "fix the flaky login test"
```

Jev returns decisions and probabilities, not generated step output. Commands use argv
arrays rather than a shell, and every result is printed as JSON for logging or replay.
