import argparse

from playwright.sync_api import Page, sync_playwright
from typesafe_sdk import Choice, Noul, TypeSafeClient

from route import load_api_key


def observe(page: Page) -> dict:
    elements = page.locator("a, button, input, textarea").evaluate_all(
        """els => els.filter(e => {
          const r = e.getBoundingClientRect();
          return r.width && r.height && !e.disabled;
        }).slice(0, 80).map((e, i) => {
          e.dataset.jevId = String(i);
          return {id: String(i), role: e.tagName.toLowerCase(),
            text: (e.innerText || e.value || e.placeholder || e.ariaLabel || '').trim().slice(0, 160)};
        })"""
    )
    return {
        "url": page.url,
        "title": page.title(),
        "page": page.locator("body").inner_text()[:6000],
        "elements": elements,
    }


def decide(client: TypeSafeClient, task: str, state: dict, recent_actions: list[str]):
    choices = {item["id"]: f'{item["role"]}: {item["text"] or "(unlabelled)"}' for item in state["elements"]}
    response = client.system_one(
        state={"task": task, "browser": state, "recentActions": recent_actions},
        questions={
            "done": Noul(instructions="Does the current browser state clearly show that `task` is complete?"),
            "operation": Choice(
                instructions="Which next operation best advances `task`? Choose finish only when it is already complete.",
                criteria={"click": "Activate a link or button", "input": "Enter the provided input value", "finish": "No more browser action is needed"},
            ),
            "click_target": Choice(instructions="If clicking next, which `browser.elements` id best advances `task`?", criteria=choices),
            "input_target": Choice(instructions="If entering text next, which `browser.elements` id should receive it?", criteria=choices),
        },
    )
    return response.answers


def run(url: str, task: str, value: str | None, headless: bool, max_steps: int, confidence: float) -> None:
    load_api_key()
    with sync_playwright() as playwright, TypeSafeClient() as client:
        browser = playwright.chromium.launch(channel="chrome", headless=headless)
        page = browser.new_page()
        page.goto(url, wait_until="domcontentloaded")
        recent_actions = []
        for step in range(1, max_steps + 1):
            state = observe(page)
            if not state["elements"]:
                raise SystemExit("No actionable elements found.")
            answers = decide(client, task, state, recent_actions)
            operation = answers["operation"]
            print(f"{step}: {operation.choice} ({operation.confidence:.2f}), done={answers['done'].noul:.2f}")
            if answers["done"].noul >= 0.8:
                browser.close()
                return
            if operation.confidence < confidence:
                raise SystemExit("Stopped: Jev was not confident enough to act.")
            if operation.choice == "finish":
                browser.close()
                return
            target = answers[f"{operation.choice}_target"]
            if target.confidence < confidence:
                raise SystemExit("Stopped: Jev was not confident enough to act.")
            locator = page.locator(f'[data-jev-id="{target.choice}"]')
            if operation.choice == "click":
                locator.click()
                action = f"clicked {target.choice}"
            else:
                if value is None:
                    raise SystemExit("Stopped: Jev chose input; pass --value with the text to enter.")
                locator.fill(value)
                locator.press("Enter")
                action = f"entered provided value in {target.choice}"
            recent_actions = (recent_actions + [action])[-5:]
            page.wait_for_timeout(300)
        raise SystemExit(f"Stopped after {max_steps} steps.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Minimal confidence-gated Jev browser agent.")
    parser.add_argument("url", nargs="?")
    parser.add_argument("task", nargs="?")
    parser.add_argument("--value", help="Text Jev may enter when it selects an input.")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--max-steps", type=int, default=10)
    parser.add_argument("--confidence", type=float, default=0.55)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        assert 0 <= args.confidence <= 1 and args.max_steps > 0
        print("ok")
        return
    if not args.url or not args.task:
        parser.error("url and task are required unless --check is used")
    run(args.url, args.task, args.value, not args.headed, args.max_steps, args.confidence)


if __name__ == "__main__":
    main()
