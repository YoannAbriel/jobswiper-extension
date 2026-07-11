# Capture protocol (release gate)

Manual, human-run gate that exercises the extension's save flow against real
LinkedIn surfaces and fails the release if any attempt produces a dry fail.

## Rules

- TEST account only. NEVER the prod admin account. The script hard-exits with a
  message if `PROFILE_DIR` is unset, so it can never silently launch against the
  wrong profile.
- Baseline BEFORE a selector change, then run again post-fix: the target is
  0 dry fails / 100.
- Success = the save button gains the `saved` class ONLY (`.jobswiper-save-btn.saved`).
  A `.jobswiper-toast` also renders on error ('Error: ...', 'Log in to JobSwiper
  first'), so it is NOT counted as a success.
- LinkedIn challenges (checkpoint/authwall) are SKIPPED and REPLAYED: a skip does
  not consume a real-attempt slot, so `N` REAL save attempts always run. This is
  checked both at page load and mid-attempt (a wall thrown after `goto` counts as
  a skip, never a dry fail).
- Hard cap: 30 total skips. Beyond that the run ABORTS with exit code 2 ('too many
  challenges, run aborted'), distinct from the dry-fail exit 1. Too many walls mean
  the TEST account is rate-limited, not that the extension is broken.
- Surfaces exercised (logged in): the two list surfaces below plus, on odd
  iterations, the job DETAIL surface (`/jobs/view/...`) reached from the first job
  card on the current list. The detail attempt feeds ok/dryFail like any other.
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

## Guest (logged-out) surface

The guest variant is NOT faked in-script. It is the SAME gate re-run against a
logged-OUT profile: point `PROFILE_DIR` at a persistent Chrome profile that is
NOT logged into LinkedIn and run the script again as a separate run.

```bash
# Separate run, logged-out profile: exercises the guest-facing save path.
PROFILE_DIR=/path/to/logged-out-profile node test/protocol/capture-run.mjs 40
```

Logged out, LinkedIn serves the authwall on most job surfaces, so expect a high
skip count. If skips reach the cap the run aborts (exit 2), which is the expected
signal that the guest surface is wall-gated, not that the extension failed.

## Cadence

Run before each extension release, and after any LinkedIn revamp detected via
the `extraction_method` telemetry in `/admin`.
