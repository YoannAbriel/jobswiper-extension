/**
 * JobSwiper Extension — Background Service Worker
 * Handles API calls to JobSwiper backend.
 */

// Shared helpers (API_BASE, fetchWithTimeout, extVersion) live in utils/shared.js
// so the four site content scripts and this service worker do not each keep a
// copy. importScripts is valid because this is a classic (non-module) SW.
importScripts('utils/shared.js')
const { API_BASE, fetchWithTimeout, extVersion } = self.JobSwiperShared

// i18n helper: resolve a message key, falling back to the key itself.
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key

// Refresh the access token when it has less than this many seconds left.
// 120s buys enough headroom that a slow saveJob fetch still completes
// against a still-valid token even after the SW yields between
// getValidToken() and the actual fetch.
const REFRESH_THRESHOLD_SECONDS = 120

// ── Independent session pull ──
// Fetch a fresh INDEPENDENT session from GET /api/extension/auth (the app mints
// one server-side so refreshing the extension token never rotates the web app
// cookie session). This is the authoritative auth path; autoConnect (below,
// which scrapes the SHARED cookie token out of an open tab) is only a
// last-resort fallback for when /auth is unreachable.
//
// Dedup: skip when we already hold an independent, still-usable session, so an
// app SIGNED_IN ping does not mint a new session on every event.
async function pullIndependentSession(force = false) {
  if (!force) {
    const { refresh_token, expires_at, session_independent } =
      await chrome.storage.local.get(['refresh_token', 'expires_at', 'session_independent'])
    const stillFresh = expires_at && (expires_at - Math.floor(Date.now() / 1000) > REFRESH_THRESHOLD_SECONDS)
    if (session_independent && refresh_token && stillFresh) return true
  }
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/auth`, {
      credentials: 'include',
      headers: { 'X-JobSwiper-Ext-Version': extVersion() },
    }, 10000)
    if (!res.ok) return false
    const data = await res.json()
    if (!data?.token) return false
    await chrome.storage.local.set({
      token: data.token,
      refresh_token: data.refresh_token ?? null,
      expires_at: data.expires_at ?? null,
      session_independent: true,
    })
    return true
  } catch {
    return false
  }
}

// ── Auto-connect: find open JobSwiper tab and grab token (FALLBACK ONLY) ──

async function autoConnect() {
  const { token } = await chrome.storage.local.get('token')
  if (token) return // Already connected

  const tabs = await chrome.tabs.query({
    url: [
      'https://jobswiper.ai/*',
      'https://www.jobswiper.ai/*',
    ]
  })

  for (const tab of tabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Supabase stores auth as sb-<ref>-auth-token in localStorage
          for (const key of Object.keys(localStorage)) {
            if (key.includes('auth-token') && key.includes('sb-')) {
              try {
                const data = JSON.parse(localStorage.getItem(key))
                if (!data?.access_token) return null
                return {
                  access_token: data.access_token,
                  refresh_token: data.refresh_token || null,
                  expires_at: data.expires_at || null,
                }
              } catch { return null }
            }
          }
          return null
        },
      })

      const session = results?.[0]?.result
      if (session?.access_token) {
        await chrome.storage.local.set({
          token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
        })
        console.log('[JobSwiper] Auto-connected via open tab')
        return
      }
    } catch {}
  }
}

// ── Token refresh ────────────────────────────────────

async function refreshAccessToken(refreshToken) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Safe here: the SW request is CORS-exempt (host_permissions), so a
        // custom header does not trip the refresh route's preflight.
        'X-JobSwiper-Ext-Version': extVersion(),
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, 8000)
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.token) return null
    return {
      token: data.token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      expires_in: data.expires_in,
    }
  } catch {
    return null
  }
}

// Single-flight guard: rapid concurrent callers (e.g. two SAVE_JOB
// messages a few ms apart) would otherwise each trigger refreshSession.
// Supabase rotates refresh_token on every successful refresh, so the
// loser of the race writes a stale tuple over the fresh one and the
// next call gets invalid_refresh_token.
let inflightRefresh = null

/**
 * Returns a non-null access token if one is available (refreshed when
 * needed), or null when there's nothing to use. Falls back to the stored
 * token on refresh failure: the upcoming fetch will get a 401 and surface
 * the auth error path naturally.
 */
async function getValidToken() {
  const { token, refresh_token, expires_at } = await chrome.storage.local.get([
    'token', 'refresh_token', 'expires_at',
  ])
  if (!token) return null

  const nowSeconds = Math.floor(Date.now() / 1000)
  const needsRefresh = expires_at && (expires_at - nowSeconds) < REFRESH_THRESHOLD_SECONDS
  if (!needsRefresh || !refresh_token) return token

  if (!inflightRefresh) {
    inflightRefresh = (async () => {
      try {
        const refreshed = await refreshAccessToken(refresh_token)
        if (!refreshed) return null
        const { session_independent } = await chrome.storage.local.get('session_independent')
        await chrome.storage.local.set({
          token: refreshed.token,
          refresh_token: refreshed.refresh_token,
          expires_at: refreshed.expires_at,
          // Rotating within the same family preserves independence; keep the
          // flag truthful so it never outlives the chain it describes.
          session_independent: !!session_independent,
        })
        // Only the legacy SHARED-chain path needs to push the rotated token back
        // into the app. An INDEPENDENT extension session is a separate chain by
        // design, so propagating it would overwrite (and break) the app session.
        if (!session_independent) void propagateSessionToApp(refreshed)
        return refreshed.token
      } finally {
        inflightRefresh = null
      }
    })()
  }
  const refreshedToken = await inflightRefresh
  return refreshedToken || token
}

async function clearAuthState() {
  await chrome.storage.local.remove(['token', 'refresh_token', 'expires_at', 'userProfile', 'userProfileMeta', 'session_independent'])
}

// ── Profile pull for autofill (SW-only fetch) ──────────
// The autofill content script never fetches and never sees a token. It asks the
// SW (GET_PROFILE), which fetches GET /api/extension/profile with getValidToken()
// (same pattern as SAVE_JOB / PULL_SESSION) and caches the result 30 min under
// the existing userProfile key (the key detect.js STORE_PROFILE and autofill
// read). Cache metadata (timestamp, locale, completeness) is kept separately in
// userProfileMeta so the profile object stays a clean field map.
const PROFILE_CACHE_TTL_MS = 30 * 60 * 1000

async function getProfile() {
  const token = await getValidToken()
  if (!token) return { ok: false, error: t('authenticationRequiredError') }

  const { userProfile, userProfileMeta } = await chrome.storage.local.get(['userProfile', 'userProfileMeta'])
  const fresh = userProfileMeta && (Date.now() - userProfileMeta.ts < PROFILE_CACHE_TTL_MS)
  if (userProfile && fresh) {
    return {
      ok: true,
      profile: userProfile,
      locale: userProfileMeta.locale ?? null,
      completeness: userProfileMeta.completeness ?? null,
      cached: true,
    }
  }

  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/profile`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        // CORS-exempt on the SW (host_permissions), so a custom header is safe.
        'X-JobSwiper-Ext-Version': extVersion(),
      },
    }, 10000)

    if (res.status === 401) {
      await chrome.storage.local.remove(['token', 'refresh_token', 'expires_at'])
      return { ok: false, error: t('authenticationRequiredError') }
    }
    if (!res.ok) {
      // Fall back to a stale cached profile rather than failing the button.
      if (userProfile) {
        return {
          ok: true,
          profile: userProfile,
          locale: userProfileMeta?.locale ?? null,
          completeness: userProfileMeta?.completeness ?? null,
          cached: true,
          stale: true,
        }
      }
      return { ok: false, error: `HTTP ${res.status}` }
    }

    const data = await res.json()
    const profile = data?.profile || {}
    await chrome.storage.local.set({
      userProfile: profile,
      userProfileMeta: {
        ts: Date.now(),
        locale: data?.locale ?? null,
        completeness: data?.completeness ?? null,
        version: data?.version ?? null,
      },
    })
    return {
      ok: true,
      profile,
      locale: data?.locale ?? null,
      completeness: data?.completeness ?? null,
    }
  } catch {
    if (userProfile) {
      return {
        ok: true,
        profile: userProfile,
        locale: userProfileMeta?.locale ?? null,
        completeness: userProfileMeta?.completeness ?? null,
        cached: true,
        stale: true,
      }
    }
    return { ok: false, error: 'network' }
  }
}

// ── CV attach at apply (Phase 3, SW-only fetch) ────────
// content/cv-attach.js never fetches and never sees a token. It asks the SW for
// the CV list (GET_CVS), the CV PDF bytes (FETCH_CV_PDF), and to record the
// chosen CV (SELECT_CV). The bearer token stays in the SW on all three; the
// content script only ever receives ids/titles and base64 bytes.
const MAX_PDF_BYTES = 10 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// List the CVs selectable for this application (titles + ids only, no bytes).
// likedJobId is optional: a raw ATS page has none, so the app returns the
// user's standalone list; an app-triggered flow passes the job for a per-job
// default. Every field returned is already user-scoped server-side.
async function getCvsList(likedJobId) {
  const token = await getValidToken()
  if (!token) return { ok: false, error: 'auth' }
  if (likedJobId && !UUID_RE.test(likedJobId)) return { ok: false, error: 'bad_liked_job_id' }
  try {
    const qs = likedJobId ? `?likedJobId=${encodeURIComponent(likedJobId)}` : ''
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/cvs${qs}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-JobSwiper-Ext-Version': extVersion(),
      },
    }, 10000)
    if (res.status === 401) return { ok: false, error: 'auth' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    return {
      ok: true,
      jobCv: data?.jobCv ?? null,
      cvs: Array.isArray(data?.cvs) ? data.cvs : [],
      defaultCvId: data?.defaultCvId ?? null,
      selectedCvId: data?.selectedCvId ?? null,
      filenameBase: data?.filenameBase ?? null,
    }
  } catch {
    return { ok: false, error: 'network' }
  }
}

// ── Apply-surface stats for the sidebar Activité view (SW-only fetch) ──
// The sidebar (content/autofill.js surface) asks the SW for a small activity
// summary (saved / applied / recent). Token stays in the SW; this only PROXIES
// the existing GET /api/extension/stats endpoint (no new app endpoint), same
// getValidToken() + version-header pattern as the other handlers.
async function getStats() {
  const token = await getValidToken()
  if (!token) return { ok: false, error: 'auth' }
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/stats`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-JobSwiper-Ext-Version': extVersion(),
      },
    }, 10000)
    if (res.status === 401) return { ok: false, error: 'auth' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    // Pass the server fields (saved / applied / recent / ...) through at the top
    // level, mirroring getCvsList's shape so the sidebar reads them directly.
    return { ok: true, ...(data && typeof data === 'object' ? data : {}) }
  } catch {
    return { ok: false, error: 'network' }
  }
}

// SW-side chunked base64 of the raw PDF bytes. String.fromCharCode.apply over
// 32 KB windows keeps us under the argument-count limit for large PDFs.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// Content-Disposition filename (RFC 5987 filename* first, then plain filename).
function parseContentDispositionFilename(cd) {
  if (!cd) return null
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)
  if (star) {
    const raw = star[1].replace(/^"|"$/g, '')
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  return plain ? plain[1] : null
}

// Fetch ONE CV's PDF, by uuid cvId only, from the hardcoded API_BASE (no
// page-supplied URL, so no SSRF surface). Enforces a 10 MB cap before base64
// crosses back to the content script.
async function fetchCvPdf(cvId) {
  if (!UUID_RE.test(cvId || '')) return { ok: false, error: 'bad_cv_id' }
  const token = await getValidToken()
  if (!token) return { ok: false, error: 'auth' }
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/api/export-cv?cvId=${encodeURIComponent(cvId)}&format=pdf`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-JobSwiper-Ext-Version': extVersion(),
        },
      },
      60000, // canvas export goes through Puppeteer, up to ~60s
    )
    if (res.status === 401) return { ok: false, error: 'auth' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const declared = res.headers.get('content-length')
    if (declared && Number(declared) > MAX_PDF_BYTES) return { ok: false, error: 'too_large' }
    const buffer = await res.arrayBuffer()
    if (buffer.byteLength > MAX_PDF_BYTES) return { ok: false, error: 'too_large' }
    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      filename: parseContentDispositionFilename(res.headers.get('content-disposition')),
      size: buffer.byteLength,
    }
  } catch {
    return { ok: false, error: 'network' }
  }
}

// Record which CV the user attached for a job. No-op without a likedJobId (the
// raw ATS page has none); used by the app-triggered flow that knows the job.
async function recordSelectedCv(likedJobId, cvId) {
  if (!likedJobId) return { ok: true, skipped: true }
  if (!UUID_RE.test(likedJobId)) return { ok: false, error: 'bad_liked_job_id' }
  if (!UUID_RE.test(cvId || '')) return { ok: false, error: 'bad_cv_id' }
  const token = await getValidToken()
  if (!token) return { ok: false, error: 'auth' }
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/select-cv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JobSwiper-Ext-Version': extVersion(),
      },
      body: JSON.stringify({ likedJobId, cvId }),
    }, 10000)
    if (res.status === 401) return { ok: false, error: 'auth' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch {
    return { ok: false, error: 'network' }
  }
}

/**
 * Dual-logout fix (#3). The web app and the extension share ONE Supabase
 * refresh token (ExtensionAuthSync syncs the app's refresh_token to the
 * extension). Supabase ROTATES the refresh token on every refresh, so when the
 * extension refreshes it, the app's stored copy goes stale and the app's own
 * next auto-refresh gets invalid_refresh_token, logging the web session out.
 *
 * Extension-side mitigation: after we rotate the token, push the fresh pair
 * back into every open app tab. We (a) merge it into the app's persisted
 * Supabase session in localStorage so the NEXT app load uses the rotated token,
 * and (b) postMessage it so a live tab can adopt it immediately.
 *
 * NEEDS-APP-COORDINATION: for the CURRENTLY loaded tab to adopt the token
 * without a reload, ExtensionAuthSync must listen for
 * JOBSWIPER_EXT_TOKEN_REFRESHED and call
 * supabase.auth.setSession({ access_token, refresh_token }). Until then, the
 * localStorage merge only covers the next page load.
 */
async function propagateSessionToApp(refreshed) {
  const payload = {
    token: refreshed.token,
    refresh_token: refreshed.refresh_token,
    expires_at: refreshed.expires_at ?? null,
    expires_in: refreshed.expires_in ?? null,
  }
  try {
    const tabs = await chrome.tabs.query({ url: ['https://jobswiper.ai/*', 'https://www.jobswiper.ai/*'] })
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (p) => {
            try {
              for (const key of Object.keys(localStorage)) {
                if (!key.includes('sb-') || !key.includes('auth-token')) continue
                let obj
                try { obj = JSON.parse(localStorage.getItem(key)) } catch { continue }
                if (!obj || !obj.access_token) continue
                obj.access_token = p.token
                obj.refresh_token = p.refresh_token
                if (p.expires_at != null) obj.expires_at = p.expires_at
                if (p.expires_in != null) obj.expires_in = p.expires_in
                localStorage.setItem(key, JSON.stringify(obj))
              }
            } catch {}
            window.postMessage({ source: 'jobswiper-extension', type: 'JOBSWIPER_EXT_TOKEN_REFRESHED', payload: p }, '*')
          },
          args: [payload],
        })
      } catch {}
    }
  } catch {}
}

// Run on install + service worker wake
autoConnect()

// Job sites the content scripts inject into. URL pattern only — used to decide
// whether the active tab is auto-importable on first install.
const SUPPORTED_JOB_HOST_REGEX = /(linkedin\.com\/(?:comm\/)?jobs\/|indeed\.com\/|wttj\.co|welcometothejungle\.com|jobup\.ch|jobs\.ch)/i

function isSupportedJobSite(url) {
  if (!url) return false
  try { return SUPPORTED_JOB_HOST_REGEX.test(url) } catch { return false }
}

// YOA-217: when the dashboard tab is open, broadcast import events into it
// so it can refresh its sidebar counts + show a toast without a manual reload.
async function broadcastJobImported(payload) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://jobswiper.ai/*', 'https://www.jobswiper.ai/*'] })
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (p) => {
            window.postMessage({ source: 'jobswiper-extension', type: 'JOBSWIPER_JOB_IMPORTED', payload: p }, '*')
          },
          args: [payload],
        })
      } catch {}
    }
  } catch {}
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await autoConnect()

  // Updates and reloads should not re-trigger the welcome flow.
  if (details?.reason !== 'install') return

  // Open the dashboard so the user has a place to land. The query string is a
  // hint for the dashboard to surface a "welcome, extension active" toast.
  try {
    await chrome.tabs.create({ url: `${API_BASE}/dashboard/search?welcome=extension` })
  } catch {}

  // If the active tab is already a job page, ask its content script to import
  // the visible job. Fails silently if the user isn't logged in yet.
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (active && isSupportedJobSite(active.url)) {
      try {
        await chrome.tabs.sendMessage(active.id, { type: 'AUTO_IMPORT_CURRENT_JOB' })
      } catch {}
    }
  } catch {}

  // Friendly system notification so the user has visible confirmation that
  // the extension is alive even if they're not on a job site yet.
  try {
    chrome.notifications.create('jobswiper-installed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: chrome.i18n.getMessage('installedTitle'),
      message: chrome.i18n.getMessage('installedBody'),
      priority: 1,
    })
  } catch {}
})

// YOA-238: SPA navigation INTO /jobs/ from a non-/jobs/ origin (feed, profile,
// search) does not re-trigger manifest content_scripts, so the save bar never
// appears until a hard refresh. On every history state update matching /jobs/,
// probe whether the content script is already loaded and inject it on miss.
// The sentinels in linkedin.js + linkedin-main.js make injection idempotent.
if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener(
    async (details) => {
      if (details.frameId !== 0) return
      const tabId = details.tabId

      let alreadyLoaded = false
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => !!window.__jobswiper_linkedin_loaded,
        })
        alreadyLoaded = !!res?.result
      } catch {
        return
      }

      if (!alreadyLoaded) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['utils/shared.js', 'utils/match.js', 'content/linkedin.js'],
          })
          await chrome.scripting.insertCSS({
            target: { tabId },
            files: ['content/jobswiper.css', 'content/overlay.css'],
          })
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content/linkedin-main.js'],
            world: 'MAIN',
          })
        } catch {}
      }

      chrome.tabs.sendMessage(tabId, { type: 'LINKEDIN_NAV', url: details.url }).catch(() => {})
    },
    { url: [{ hostSuffix: 'linkedin.com', pathPrefix: '/jobs/' }, { hostSuffix: 'linkedin.com', pathPrefix: '/comm/jobs/' }] },
  )
}

// Async message handlers wrapped in a single dispatch, so we can use await
// throughout and always return `true` to keep the channel open.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ;(async () => {
    try {
      switch (message?.type) {
        case 'AUTO_CONNECT': {
          // Prefer the independent-session mint; fall back to scraping an open
          // tab's shared token only if /auth is unreachable.
          const pulled = await pullIndependentSession()
          if (!pulled) await autoConnect()
          const token = await getValidToken()
          sendResponse({ success: !!token, token })
          return
        }
        case 'PULL_SESSION': {
          // Fired by detect.js when the web app signals pull_session on login.
          const ok = await pullIndependentSession(message.force === true)
          sendResponse({ success: ok })
          return
        }
        case 'SAVE_JOB': {
          // Refresh the access token if it is about to expire so the user
          // does not get silently logged out after the 1h Supabase TTL.
          const token = await getValidToken()
          if (!token) {
            sendResponse({ success: false, error: t('authenticationRequiredError') })
            return
          }
          const result = await saveJob(message.data, token)
          if (result.success && !result.alreadyLiked) {
            scheduleReminder(message.data.title, message.data.company)
          }
          if (result.success) {
            // YOA-217: live-update the dashboard tab if open.
            broadcastJobImported({
              jobId: result.jobId,
              likedJobId: result.likedJobId,
              title: message.data.title,
              company: message.data.company,
              alreadyLiked: !!result.alreadyLiked,
            })
          }
          sendResponse(result)
          return
        }
        case 'CHECK_AUTH': {
          const token = await getValidToken()
          sendResponse({ authenticated: !!token, token })
          return
        }
        case 'SET_TOKEN': {
          // Legacy single-field write, kept for content scripts injected
          // before the STORE_AUTH path landed. Clear refresh_token and
          // expires_at so the new access token isn't paired with a stale
          // pre-existing tuple in getValidToken. Remove after one release.
          await chrome.storage.local.set({ token: message.token })
          await chrome.storage.local.remove(['refresh_token', 'expires_at'])
          sendResponse({ success: true })
          return
        }
        case 'STORE_AUTH': {
          // Single-writer entry for the auth bundle so popup, detect, and
          // the SW itself never race on chrome.storage.local writes.
          const update = { token: message.token }
          if (message.refresh_token !== undefined) update.refresh_token = message.refresh_token
          if (message.expires_at !== undefined) update.expires_at = message.expires_at
          await chrome.storage.local.set(update)
          sendResponse({ success: true })
          return
        }
        case 'STORE_PROFILE': {
          await chrome.storage.local.set({ userProfile: message.profile })
          sendResponse({ success: true })
          return
        }
        case 'GET_PROFILE': {
          // SW-side profile fetch for autofill. The token never leaves the SW.
          // Only this extension's own contexts may pull the profile PII (there
          // is no externally_connectable today; this future-proofs against it).
          if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return }
          const result = await getProfile()
          sendResponse(result)
          return
        }
        case 'GET_CVS': {
          // CV list for the attach control. Ids + titles only, no bytes. Gated
          // to this extension's own contexts (mirrors GET_PROFILE).
          if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return }
          sendResponse(await getCvsList(message.likedJobId || null))
          return
        }
        case 'FETCH_CV_PDF': {
          // CV PDF bytes for attach/download. Token stays in the SW; the URL is
          // API_BASE + uuid cvId only (no page-supplied URL); 10 MB capped.
          if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return }
          sendResponse(await fetchCvPdf(message.cvId))
          return
        }
        case 'SELECT_CV': {
          // Persist the chosen CV for a known job (no-op without a likedJobId).
          if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return }
          sendResponse(await recordSelectedCv(message.likedJobId || null, message.cvId))
          return
        }
        case 'GET_STATS': {
          // Activity summary for the sidebar Activité view. Proxies the existing
          // GET /api/extension/stats; token stays in the SW. Gated to this
          // extension's own contexts (mirrors GET_PROFILE / GET_CVS).
          if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return }
          sendResponse(await getStats())
          return
        }
        case 'LOGOUT': {
          await clearAuthState()
          sendResponse({ success: true })
          return
        }
        case 'PARSE_JOB_PAGE': {
          // AI extraction fallback: slower than a save, so a 20s timeout.
          // On a non-ok HTTP response we forward the server's JSON body
          // (which carries { success: false, error }) rather than throwing,
          // so the caller sees the real server-side reason.
          const token = await getValidToken()
          if (!token) {
            sendResponse({ success: false, error: t('notAuthenticatedError') })
            return
          }
          const response = await fetchWithTimeout(
            `${API_BASE}/api/extension/parse-job-page`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ page_text: message.pageText, url: message.url }),
            },
            20000,
          )
          const json = await response.json()
          sendResponse(json)
          return
        }
        default:
          sendResponse({ success: false, error: 'Unknown message type' })
      }
    } catch (err) {
      sendResponse({ success: false, error: err?.message || 'Unknown error' })
    }
  })()
  return true
})

// ── Reminder notifications ──────────────────────────

// Set a reminder when a job is saved
async function scheduleReminder(jobTitle, jobCompany) {
  const alarmName = `reminder-${Date.now()}`
  chrome.alarms.create(alarmName, { delayInMinutes: 60 * 24 * 3 })
  const { reminders = [] } = await chrome.storage.local.get('reminders')
  const next = [...reminders, { alarm: alarmName, title: jobTitle, company: jobCompany, created: Date.now() }].slice(-20)
  await chrome.storage.local.set({ reminders: next })
}

// Handle alarm fire
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('reminder-')) return
  const { reminders = [] } = await chrome.storage.local.get('reminders')
  const reminder = reminders.find(r => r.alarm === alarm.name)
  if (!reminder) return
  // Buttons are silently ignored on Firefox (Bugzilla 1190681). The body
  // click is wired to onClicked below and works on every browser.
  chrome.notifications.create(alarm.name, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: chrome.i18n.getMessage('reminderTitle'),
    message: chrome.i18n.getMessage('reminderBody', [reminder.title, reminder.company]),
    priority: 1,
  })
  await chrome.storage.local.set({ reminders: reminders.filter(r => r.alarm !== alarm.name) })
})

// Handle notification click
chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${API_BASE}/dashboard/jobs` })
})

async function saveJob(jobData, token) {
  const response = await fetchWithTimeout(`${API_BASE}/api/extension/import-job`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      // #6: version negotiation. Safe on this SW request (CORS-exempt via
      // host_permissions); the app can log/read it to detect stale builds.
      'X-JobSwiper-Ext-Version': extVersion(),
    },
    body: JSON.stringify(jobData),
  }, 15000)

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }

  return await response.json()
}
