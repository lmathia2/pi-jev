import argparse
import csv
import os
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from typesafe_sdk import Choice, TypeSafeClient


ROUTES = {
    "code": "Implement, debug, test, refactor, or explain software and technical systems.",
    "research": "Find, verify, compare, or summarize information from sources.",
    "data": "Analyze, transform, visualize, or explain statistics and structured data, even when the data still needs to be supplied.",
    "write": "Create or edit standalone content such as articles, documentation, marketing copy, translations, or reports; excludes messages and meeting artifacts.",
    "plan": "Design a strategy, schedule, workflow, architecture, or sequence of future work.",
    "act": "Operate tools or services to perform a concrete external action or automation.",
    "communicate": "Prepare person-to-person email, chat, replies, handoffs, agendas, meeting notes, talking points, or follow-ups, whether drafting or sending.",
    "clarify": "The intended task itself is unclear, unsupported, or purely conversational; do not choose this merely because a clear task still needs its input artifact.",
}

# Hand-labeled synthetic evaluation set: short, long, indirect, multi-step, and ambiguous requests.
EXAMPLES = {
    "code": [
        "Fix the flaky login test.",
        "Why does this Python generator stop after the first yield?",
        "Add cursor pagination to the existing users endpoint without changing its response shape.",
        "Review this pull request for race conditions and leave concise findings.",
        "Convert the callback-based image loader to async/await and preserve cancellation.",
        "The build passes locally but fails on Linux because file names differ only by case; diagnose it.",
        "Write a SQL migration that makes email unique while safely reporting existing duplicates.",
        "Can you reduce this React component's rerenders without adding another state library?",
        "Trace the checkout request from the route through the service and explain where tax is rounded.",
        "Implement webhook signature verification, reject stale timestamps, and add one focused test.",
    ],
    "research": [
        "Who invented the lithium-ion battery?",
        "Find the current limits for GitHub Actions hosted runners and cite the official docs.",
        "Compare the evidence for creatine improving cognition in sleep-deprived adults.",
        "Verify whether this quote is actually in the 2018 shareholder letter.",
        "Summarize the latest three papers on small language model routing, noting dataset sizes.",
        "What changed between the two most recent versions of the WebAuthn specification?",
        "Find primary sources for urban heat-island mitigation and separate measured results from projections.",
        "Research competitors offering usage-based billing APIs for European SaaS companies.",
        "Is the claim that octopuses have nine brains accurate, and what do biologists actually mean?",
        "Locate the original dataset behind this chart and assess whether the caption matches it.",
    ],
    "data": [
        "Calculate monthly churn from this CSV.",
        "Plot conversion rate by acquisition channel with 95% confidence intervals.",
        "Join the orders and refunds sheets, then flag customers whose net revenue is negative.",
        "Explain why the median rose while every regional median fell.",
        "Clean these timestamps, group events into sessions after 30 minutes of inactivity, and export Parquet.",
        "Build a cohort table showing week-eight retention for each signup month.",
        "Which variables best predict late delivery, and are any of them likely leakage?",
        "Compare forecast error by store, excluding locations with fewer than twenty observations.",
        "The dashboard total differs from finance by 2.4%; reconcile the definitions and identify the rows.",
        "Run a sensitivity analysis on the break-even model across price, demand, and support cost assumptions.",
    ],
    "write": [
        "Rewrite this paragraph more clearly.",
        "Draft a friendly onboarding email for trial users who have not invited a teammate.",
        "Translate the release notes into German while leaving command names unchanged.",
        "Turn these rough notes into a one-page executive brief with a direct recommendation.",
        "Edit this grant proposal for flow and remove claims that are not supported by the cited results.",
        "Write three headline options for a privacy-focused photo app; avoid fear-based language.",
        "Condense the incident report to 200 words without dropping the timeline or customer impact.",
        "Adapt this technical tutorial for product managers who understand APIs but do not code.",
        "Create an FAQ from the policy text, quoting the policy only when exact wording matters.",
        "Make this apology sound accountable rather than defensive, and do not promise a delivery date.",
    ],
    "plan": [
        "Plan a two-day team offsite.",
        "Break the billing migration into reversible phases with acceptance criteria.",
        "Design a six-week study plan for someone who knows Python but not linear algebra.",
        "Propose an architecture for processing ten million events daily with regional failover.",
        "Create a launch checklist that assigns owners across engineering, support, legal, and marketing.",
        "We need to cut cloud cost by 20% without hurting latency; prioritize experiments for the next month.",
        "Map a safe rollout from shared admin passwords to hardware-backed single sign-on.",
        "Outline how to validate product demand before committing a full engineering team.",
        "Schedule the kitchen renovation so plumbing, electrical, cabinets, and inspections do not block each other.",
        "Develop a contingency plan for a conference if the keynote cancels on the morning of the event.",
    ],
    "act": [
        "Create a reminder for Friday at 4 PM.",
        "Deploy the current main branch to staging and show me the health check.",
        "Book the cheapest refundable nonstop flight to Seattle next Tuesday afternoon.",
        "Add every customer in this CSV to the product-announcement audience, excluding unsubscribed users.",
        "Open an issue for the memory leak and attach the heap profile.",
        "Rename the task to Quarterly access review and pin it.",
        "Run the database backup, verify its checksum, then rotate backups older than thirty days.",
        "Update the CRM opportunity to closed-won and schedule a handoff with customer success.",
        "Monitor the status page every fifteen minutes and notify me only if the incident changes.",
        "Generate invoices for approved time entries, but stop and report any account without a tax ID.",
    ],
    "communicate": [
        "Tell Maya I'll be ten minutes late.",
        "Draft a reply asking the vendor to clarify whether support is included in year two.",
        "Summarize this meeting and list each decision, owner, and due date.",
        "Prepare talking points for explaining the delay to a frustrated enterprise customer.",
        "Write a concise status update for Slack: the fix is deployed, monitoring is clean, and no action is needed.",
        "Help me decline this speaking invitation warmly while leaving the door open for next year.",
        "Create an agenda for the design review and include the unresolved accessibility questions.",
        "Turn this tense email thread into a neutral summary I can send to both teams.",
        "Follow up with interview candidates who have been waiting more than five business days.",
        "Compose a handoff note for the on-call engineer covering impact, mitigations, and what to watch overnight.",
    ],
    "clarify": [
        "Help me with it.",
        "What do you think?",
        "Make it better.",
        "Can you handle the thing we discussed yesterday?",
        "Do the next step, but do not change anything important.",
        "I need something for the board by tomorrow.",
        "Take a look at this.",
        "It stopped working after the update.",
        "We should probably deal with the customer situation.",
        "Use the best approach and let me know when it is done.",
    ],
}


def load_api_key() -> None:
    if os.getenv("TYPESAFE_API_KEY"):
        return
    if os.getenv("JEV_API_KEY"):
        os.environ["TYPESAFE_API_KEY"] = os.environ["JEV_API_KEY"]
        return
    env_file = Path.home() / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("JEV_API_KEY="):
                os.environ["TYPESAFE_API_KEY"] = line.split("=", 1)[1].strip().strip("'\"")
                return
    raise SystemExit("Set JEV_API_KEY or TYPESAFE_API_KEY (JEV_API_KEY may be in ~/.env).")


def classify(item: tuple[str, str]) -> dict:
    expected, query = item
    with TypeSafeClient() as client:
        response = client.system_one(
            state={"query": query},
            questions={
                "route": Choice(
                    instructions="Which single agentic sub-task should handle `query`? Choose clarify when safe routing requires missing context.",
                    criteria=ROUTES,
                )
            },
        )
    answer = response.answers["route"]
    return {
        "expected": expected,
        "predicted": answer.choice,
        "confidence": round(answer.confidence, 4),
        "correct": answer.choice == expected,
        "query": query,
    }


def self_check() -> None:
    assert set(EXAMPLES) == set(ROUTES)
    assert sum(map(len, EXAMPLES.values())) == 80
    assert all(len(items) == len(set(items)) for items in EXAMPLES.values())
    print("ok: 80 unique labeled examples across 8 routes")


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Jev as an agent-task router.")
    parser.add_argument("--limit", type=int, help="Classify only the first N examples.")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--check", action="store_true", help="Validate the corpus without calling Jev.")
    args = parser.parse_args()
    if args.check:
        self_check()
        return

    load_api_key()
    items = [(label, query) for label, queries in EXAMPLES.items() for query in queries]
    if args.limit is not None:
        items = items[: args.limit]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(classify, items))

    with Path("results.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=rows[0])
        writer.writeheader()
        writer.writerows(rows)

    correct = sum(row["correct"] for row in rows)
    mistakes = Counter((row["expected"], row["predicted"]) for row in rows if not row["correct"])
    print(f"accuracy: {correct}/{len(rows)} = {correct / len(rows):.1%}")
    print(f"mean confidence: {sum(row['confidence'] for row in rows) / len(rows):.3f}")
    for (expected, predicted), count in mistakes.most_common():
        print(f"{count:>2}  {expected} -> {predicted}")
    print("wrote results.csv")


if __name__ == "__main__":
    main()
