// Release-gate protocol: N capture attempts on real LinkedIn surfaces.
// Usage: node test/protocol/capture-run.mjs [N] [--no-reload-hack]
// Requires: PROFILE_DIR env (persistent Chrome profile logged into a TEST account).
//
// This is a manual, human-run release gate. Run it against a dedicated TEST
// LinkedIn account with a logged-in persistent profile. NEVER point it at the
// prod admin account, and NEVER run it unattended in CI.
import { chromium } from 'playwright'
import path from 'node:path'

const N = Number(process.argv[2] ?? 100)
const noHack = process.argv.includes('--no-reload-hack')
const EXT_PATH = path.resolve(import.meta.dirname, '..', '..')
const PROFILE_DIR = process.env.PROFILE_DIR
if (!PROFILE_DIR) {
  console.error('Set PROFILE_DIR to a persistent profile dir (TEST account, never prod admin). See test/protocol/README.md.')
  process.exit(1)
}

const SURFACES = [
  'https://www.linkedin.com/jobs/search/?keywords=product%20designer',
  'https://www.linkedin.com/jobs/collections/recommended/',
]

// A LinkedIn challenge (checkpoint / authwall) is a skip, never a fail. Skips do
// not consume the loop budget: N REAL save attempts must run. A hard cap on total
// skips aborts the run instead of looping forever behind a wall.
const MAX_SKIPS = 30
const isChallenge = (u) => u.includes('/checkpoint/') || u.includes('/authwall')

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  userAgent: undefined,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
})
const page = await ctx.newPage()
await page.setExtraHTTPHeaders({ 'X-Harness': 'JobswiperSmoke' })

// Success = the save button gains the `saved` class ONLY. content/linkedin.js sets
// className 'jobswiper-save-btn saved' exclusively on a real save; a `.jobswiper-toast`
// also renders on error ('Error: ...', 'Log in to JobSwiper first'), so it is NOT a
// success signal and must not be part of the wait selector.
async function attemptSave() {
  const btn = page.locator('.jobswiper-save-btn').first()
  await btn.waitFor({ timeout: 15000 })
  await btn.click()
  await page.locator('.jobswiper-save-btn.saved').first().waitFor({ timeout: 30000 })
}

let ok = 0, dryFail = 0, skipped = 0, realAttempts = 0

async function abort() {
  console.error(`\nRESULT aborted: too many challenges (${skipped} skips, cap ${MAX_SKIPS}), run aborted`)
  console.error(`ok=${ok} dryFail=${dryFail} skipped=${skipped} realAttempts=${realAttempts}/${N}`)
  await ctx.close()
  process.exit(2)
}

// Returns true if the skip cap has been reached and the run must abort.
function registerSkip(label) {
  skipped++
  console.log(`[${label}] SKIP challenge (${skipped}/${MAX_SKIPS})`)
  return skipped >= MAX_SKIPS
}

while (realAttempts < N) {
  const i = realAttempts
  const url = SURFACES[i % SURFACES.length]
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (isChallenge(page.url())) {
    if (registerSkip(`${i}`)) await abort()
    continue // replay: do NOT consume a real-attempt slot
  }
  if (noHack) {
    // Best effort: chrome.storage is not always reachable from the page context.
    // If this no-ops, set disableReloadHack from the service-worker console
    // before the run instead (see test/protocol/README.md).
    await page.evaluate(() => chrome?.storage?.local?.set?.({ disableReloadHack: true })).catch(() => {})
  }
  try {
    await attemptSave()
    ok++
    console.log(`[${i}] OK`)
  } catch {
    // A mid-attempt challenge (the page walled us after goto) is a skip, not a fail.
    if (isChallenge(page.url())) {
      if (registerSkip(`${i}`)) await abort()
      continue // replay: do NOT consume a real-attempt slot
    }
    dryFail++
    console.log(`[${i}] DRY FAIL on ${page.url()}`)
  }
  // Third logged-in surface: on odd iterations, also exercise the job DETAIL page
  // (/jobs/view/) reached from the first job card on the current list surface.
  if (i % 2 === 1) {
    try {
      const link = page.locator('a[href*="/jobs/view/"]').first()
      await link.waitFor({ timeout: 15000 })
      const href = await link.getAttribute('href')
      if (href) {
        const detailUrl = new URL(href, 'https://www.linkedin.com').toString()
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded' })
        if (isChallenge(page.url())) {
          if (registerSkip(`${i} detail`)) await abort()
        } else {
          try {
            await attemptSave()
            ok++
            console.log(`[${i}] OK detail`)
          } catch {
            if (isChallenge(page.url())) {
              if (registerSkip(`${i} detail`)) await abort()
            } else {
              dryFail++
              console.log(`[${i}] DRY FAIL detail on ${page.url()}`)
            }
          }
        }
      }
    } catch {
      // No job-card link found on this surface: detail coverage skipped silently,
      // not a fail (the list-surface attempt above already counted).
    }
  }
  realAttempts++
  await page.waitForTimeout(3000 + Math.random() * 4000)
}
console.log(`\nRESULT ok=${ok} dryFail=${dryFail} skipped=${skipped} / ${N} real attempts (hack ${noHack ? 'OFF' : 'ON'})`)
await ctx.close()
process.exit(dryFail === 0 ? 0 : 1)
