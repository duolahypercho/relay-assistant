# Contributing

Use Node 24 or newer. Run `npm ci`, `npm run dev`, and configure a model only if you need live AI behavior. Sample mode is enough for UI development.

The full test suite also requires Python 3, plus FFmpeg and ffprobe with the `fd` protocol (FFmpeg 7 or newer; Debian 13 and the current Mac build are verified). Install them before running `npm test`, or set `RELAY_FFMPEG_PATH` and `RELAY_FFPROBE_PATH`. See [video setup](docs/MEDIA_FILES.md). CI installs these dependencies explicitly.

Before submitting a change, run:

```sh
npm run format:check
npm test
npm run build
npm run test:e2e
```

Install Playwright Chromium with `npx playwright install chromium` if no compatible browser is present. Tests use isolated sample data. Voice tests require the full Chromium browser in headless mode; the minimal Linux headless shell does not support the verified synthetic-capture path. The Playwright configuration selects full Chromium automatically, and `node scripts/check-browser-capture.mjs` checks the chosen browser with synthetic audio. Browser snapshots and traces are local verification artifacts, not product assets.

Write original code. References can inform requirements and interaction patterns, but do not import competitor code, branding, mascots, screenshots, or proprietary assets. Do not include account tokens, exported personal workspaces, `.env`, or browser profiles in a contribution.

Meaningful tests should cover state transitions, provider contracts, durable work, or user journeys. Avoid tests that merely duplicate implementation details. Keep external writes behind the review invariant and make missing configuration explicit.

Describe the problem, the resulting behavior, and what you verified. Changes to real integrations should distinguish controlled adapter tests from live-account evidence.

When adding a releasable source file, review and add its relative path to `source-files.json`. Release packaging never includes unlisted files automatically. Run `npm run release:source:verify` before distributing a source archive; it performs a clean install, formatting check, Node tests, web build and byte-identical source repack. See [release preparation](docs/RELEASE.md).
