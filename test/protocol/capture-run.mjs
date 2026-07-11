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

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  userAgent: undefined,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
})
const page = await ctx.newPage()
await page.setExtraHTTPHeaders({ 'X-Harness': 'JobswiperSmoke' })

let ok = 0, dryFail = 0, skipped = 0
for (let i = 0; i < N; i++) {
  const url = SURFACES[i % SURFACES.length]
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (page.url().includes('/checkpoint/') || page.url().includes('/authwall')) {
    skipped++; console.log(`[${i}] SKIP challenge`); continue
  }
  if (noHack) {
    // Best effort: chrome.storage is not always reachable from the page context.
    // If this no-ops, set disableReloadHack from the service-worker console
    // before the run instead (see test/protocol/README.md).
    await page.evaluate(() => chrome?.storage?.local?.set?.({ disableReloadHack: true })).catch(() => {})
  }
  try {
    const btn = page.locator('.jobswiper-save-btn').first()
    await btn.waitFor({ timeout: 15000 })
    await btn.click()
    await page.locator('.jobswiper-save-btn.saved, .jobswiper-toast').first().waitFor({ timeout: 30000 })
    ok++
    console.log(`[${i}] OK`)
  } catch {
    dryFail++
    console.log(`[${i}] DRY FAIL on ${page.url()}`)
  }
  await page.waitForTimeout(3000 + Math.random() * 4000)
}
console.log(`\nRESULT ok=${ok} dryFail=${dryFail} skipped=${skipped} / ${N} (hack ${noHack ? 'OFF' : 'ON'})`)
await ctx.close()
process.exit(dryFail === 0 ? 0 : 1)
