/**
 * JobSwiper Extension — Popup with robust auth flow
 *
 * 1. User logs in on jobswiper.ai
 * 2. Clicks "Connect" in popup → calls /api/extension/auth (uses cookies)
 * 3. Gets fresh token → stored in chrome.storage
 * 4. Token used for all subsequent API calls
 */

const API_BASE = 'https://www.jobswiper.ai'

// i18n: chrome.i18n.getMessage, falls back to the key so nothing renders blank.
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key

// Localize every element carrying a data-i18n key (runs before auth resolves).
function localizeStatic() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = t(el.dataset.i18n)
    if (msg) el.textContent = msg
  })
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
}

// Brave 1.77.x sometimes leaves the SW dormant; the first sendMessage
// times out silently. One retry with a short backoff recovers.
async function callSW(message, { timeoutMs = 3000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let timeoutId
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('sw_timeout')), timeoutMs)
      })
      return await Promise.race([chrome.runtime.sendMessage(message), timeout])
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    } finally {
      clearTimeout(timeoutId)
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  localizeStatic()
  // First: try auto-connect (scan open tabs for JobSwiper)
  try {
    const result = await callSW({ type: 'AUTO_CONNECT' })
    if (result?.success && result.token) {
      showLoggedIn(result.token)
      return
    }
  } catch {}

  // Check stored token
  const { token } = await chrome.storage.local.get('token')
  if (token) {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/extension/stats`, {
        headers: { 'Authorization': `Bearer ${token}` },
      }, 8000)
      if (res.ok) { showLoggedIn(token); return }
    } catch {}
    try { await callSW({ type: 'LOGOUT' }) } catch {}
  }

  showLoggedOut()
})

function showLoggedIn(token) {
  document.body.classList.remove('logged-out')
  document.body.classList.add('logged-in')
  loadStats(token)
}

function showLoggedOut() {
  document.body.classList.remove('logged-in')
  document.body.classList.add('logged-out')
}

// Connect button: tries auto-connect (tab scan) then cookie fallback.
// Brave/Firefox can block the cookie fallback, so when both fail we open
// the dashboard in a new tab so the user can log in and retry.
document.getElementById('connect-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('connect-btn')
  const origText = btn.textContent
  btn.textContent = t('connecting')
  btn.disabled = true

  // Try 1: auto-connect via open tab (reads localStorage from a same-origin tab)
  try {
    const result = await callSW({ type: 'AUTO_CONNECT' })
    if (result?.success && result.token) {
      showLoggedIn(result.token)
      return
    }
  } catch {}

  // Try 2: cookie-based auth endpoint (may be blocked by Brave Shields)
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/auth`, {
      credentials: 'include',
    }, 10000)
    if (res.ok) {
      const data = await res.json()
      if (data.token) {
        try {
          await callSW({
            type: 'STORE_AUTH',
            token: data.token,
            refresh_token: data.refresh_token ?? null,
            expires_at: data.expires_at ?? null,
          })
        } catch {
          // SW unreachable (e.g. brief update window): direct fallback so
          // the user is not blocked. Only the popup writes on this path.
          await chrome.storage.local.set({
            token: data.token,
            refresh_token: data.refresh_token ?? null,
            expires_at: data.expires_at ?? null,
          })
        }
        showLoggedIn(data.token)
        return
      }
    }
  } catch {}

  // Both paths failed: open the dashboard so the user can log in,
  // then they reopen the popup and click Connect again.
  btn.textContent = t('openingJobswiper')
  chrome.tabs.create({ url: `${API_BASE}/dashboard` })
  setTimeout(() => { btn.textContent = origText; btn.disabled = false }, 1500)
})

// Logout: route through the SW so all auth state stays clear in one
// place (token + refresh_token + expires_at + userProfile).
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  try { await callSW({ type: 'LOGOUT' }) } catch {}
  showLoggedOut()
})

async function loadStats(token) {
  const statsEl = document.getElementById('stats')
  const recentEl = document.getElementById('recent-saves')
  if (!statsEl) return

  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/stats`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }, 8000)

    if (!res.ok) {
      if (res.status === 401) {
        try { await callSW({ type: 'LOGOUT' }) } catch {}
        showLoggedOut()
      }
      return
    }

    const data = await res.json()

    statsEl.innerHTML = `
      <div class="stat"><div class="stat-num">${data.saved}</div><div class="stat-label">${esc(t('statSaved'))}</div></div>
      <div class="stat"><div class="stat-num">${data.applied}</div><div class="stat-label">${esc(t('statApplied'))}</div></div>
    `

    const profileEl = document.getElementById('profile-bar')
    if (profileEl) {
      const pct = data.profile_completeness
      const color = pct >= 80 ? 'var(--js-emerald)' : pct >= 50 ? 'var(--js-sunset)' : 'var(--js-danger)'
      profileEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:11px;font-weight:700;color:#4b5563">${esc(t('profile'))}</span>
          <span style="font-size:11px;color:var(--js-faint);font-variant-numeric:tabular-nums">${pct}%</span>
        </div>
        <div style="height:5px;background:var(--js-border);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:3px"></div>
        </div>
      `
    }

    if (recentEl && data.recent_saves?.length > 0) {
      recentEl.innerHTML = data.recent_saves.map(s => `
        <div class="recent-item">
          <div class="recent-title">${esc(s.title)}</div>
          <div class="recent-company">${esc(s.company)}</div>
        </div>
      `).join('')
    } else if (recentEl) {
      recentEl.innerHTML = `<div style="text-align:center;color:#9ca3af;font-size:11px;padding:8px">${esc(t('noSavedJobs'))}</div>`
    }
  } catch {
    statsEl.innerHTML = `<div style="text-align:center;color:#9ca3af;font-size:11px">${esc(t('couldNotLoadStats'))}</div>`
  }
}

// ── Universal "Save this page" capture ──────────────
// Grabs the active tab's text (best frame = longest innerText), runs a
// two-threshold plausibility gate, then routes it through the same
// PARSE_JOB_PAGE + SAVE_JOB service-worker path the content scripts use.
const EXCLUDED_LINKEDIN = /linkedin\.com\/(feed|messaging|notifications|mynetwork)/
const JOB_SIGNALS = [
  /apply|postuler|candidature/i,
  /salary|salaire|compensation/i,
  /requirements|qualifications|profil recherch/i,
  /full[- ]?time|part[- ]?time|cdi|cdd|temps plein/i,
  /responsibilit|missions|about the role|votre r[oô]le/i,
  /experience|exp[eé]rience/i,
]

function plausibilityScore(text) {
  return JOB_SIGNALS.reduce((s, re) => s + (re.test(text) ? 1 : 0), 0)
}

// PII stripping is the shared window.JobSwiperExtract.stripPII from
// utils/extract-helpers.js, loaded via popup.html before this script. No local
// copy: the popup page loads the packaged module directly, keeping the email /
// profile / phone regexes in one place (phone-shaped only, so salary ranges like
// 60000-75000 and reference numbers never get masked as phones).

async function collectActiveTabText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url?.startsWith('http')) return { error: t('pageCannotBeCaptured') }
  if (EXCLUDED_LINKEDIN.test(tab.url)) {
    return { error: t('notOnLinkedInFeed') }
  }
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => document.body?.innerText?.slice(0, 20000) || '',
  })
  const best = frames.map((f) => f.result || '').sort((a, b) => b.length - a.length)[0] || ''
  return { tab, text: best }
}

document.getElementById('save-page-btn')?.addEventListener('click', async () => {
  const status = document.getElementById('save-page-status')
  const btn = document.getElementById('save-page-btn')
  status.textContent = ''
  const { tab, text, error } = await collectActiveTabText()
  if (error) { status.textContent = error; return }

  const score = plausibilityScore(text)
  if (score < 2) { status.textContent = t('notAJobPosting'); return }
  if (score < 4 && !confirm(t('notClearlyJobConfirm'))) return

  const { pageCapNoticeShown } = await chrome.storage.local.get('pageCapNoticeShown')
  if (!pageCapNoticeShown) {
    status.textContent = t('pageSentNotice')
    await chrome.storage.local.set({ pageCapNoticeShown: true })
  }

  btn.disabled = true
  btn.textContent = t('extracting')
  try {
    const stripped = window.JobSwiperExtract.stripPII(text).slice(0, 15000)
    // 25s client timeout gives room over PARSE_JOB_PAGE's 20s server-side call.
    const parsed = await callSW({ type: 'PARSE_JOB_PAGE', pageText: stripped, url: tab.url }, { timeoutMs: 25000 })
    if (!parsed?.success || !parsed.job) throw new Error(parsed?.error || t('couldNotExtractJob'))
    // SAVE_JOB resolves its own token via getValidToken in the service worker,
    // so no token is passed from here (message.token is not read by the handler).
    const saved = await callSW({
      type: 'SAVE_JOB',
      data: { ...parsed.job, source: 'page-capture', extraction_method: 'ai', url: parsed.job.url || tab.url },
    })
    if (!saved?.success) throw new Error(saved?.error || t('saveFailed'))
    btn.textContent = t('savedExclaimPlain')
    status.textContent = t('jobAtCompany', [parsed.job.title, parsed.job.company])
  } catch (e) {
    btn.textContent = t('savePageCta')
    status.textContent = e.message
  } finally {
    btn.disabled = false
    setTimeout(() => { btn.textContent = t('savePageCta') }, 3000)
  }
})
