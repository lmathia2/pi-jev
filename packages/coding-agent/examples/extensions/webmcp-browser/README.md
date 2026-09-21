# WebMCP Browser Extension

Opens a visible Chromium page and lets pi discover and call tools exposed through `document.modelContext` or `navigator.modelContext`.

## Setup

From the repository root:

```bash
npm install --ignore-scripts
npx playwright-core install chromium
pi -e packages/coding-agent/examples/extensions/webmcp-browser/index.ts
```

The extension adds `browser_open`, `webmcp_list`, `webmcp_call`, and `browser_close`. Call `webmcp_list` again after navigation because WebMCP tools are page-scoped.
