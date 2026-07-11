# Capture protocol (release gate)

Manual, human-run gate that exercises the extension's save flow against real
LinkedIn surfaces and fails the release if any attempt produces a dry fail.

## Rules

- TEST account only. NEVER the prod admin account. The script hard-exits with a
  message if `PROFILE_DIR` is unset, so it can never silently launch against the
  wrong profile.
- Baseline BEFORE a selector change, then run again post-fix: the target is
  0 dry fails / 100.
- LinkedIn challenges (checkpoint/authwall) are SKIPPED and replayed, never
  counted as failures.
- A dry fail = neither DOM extraction nor AI fallback produced a save.
- Exit code is 0 only when `dryFail === 0`. Skipped attempts do not fail the gate.

## Prerequisites

1. A dedicated TEST LinkedIn account (never the prod admin).
2. A persistent Chrome profile dir already logged into that TEST account. Point
   `PROFILE_DIR` at it. Playwright launches this profile so the session, cookies,
   and login survive across attempts.
3. Playwright browser binaries installed: `npx playwright install chromium`.
   (`playwright` is a devDependency but the binaries may not be fetched yet.)

## Run

```bash
# Default: 100 attempts, reload hack ON (production behavior)
PROFILE_DIR=/path/to/test-profile node test/protocol/capture-run.mjs

# Custom attempt count
PROFILE_DIR=/path/to/test-profile node test/protocol/capture-run.mjs 40
```

## Variant: reload hack disabled (`--no-reload-hack`)

Same run with the reload hack (Task 11 `disableReloadHack` flag) disabled. The
hack is only removed from the codebase once this variant passes clean
(0 dry fails / 100).

```bash
PROFILE_DIR=/path/to/test-profile node test/protocol/capture-run.mjs 100 --no-reload-hack
```

The script tries to set `chrome.storage.local.disableReloadHack = true` from the
page context. That access is not always granted to page scripts, so the call is
wrapped in a catch and may quietly no-op.

### Fallback: set the flag from the service-worker console

If the in-page attempt does not take effect, set the flag manually before the
run:

1. Load the unpacked extension and open `chrome://extensions`.
2. Enable Developer mode, find Job Swiper, click the "service worker" link to
   open its DevTools console.
3. Run:
   ```js
   chrome.storage.local.set({ disableReloadHack: true })
   ```
4. Confirm with `chrome.storage.local.get('disableReloadHack')`, then start the
   run with `--no-reload-hack`.

To restore normal behavior afterward:
```js
chrome.storage.local.remove('disableReloadHack')
```

## Cadence

Run before each extension release, and after any LinkedIn revamp detected via
the `extraction_method` telemetry in `/admin`.
