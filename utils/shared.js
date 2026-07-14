/**
 * JobSwiper shared helpers (used by the four site content scripts AND the
 * background service worker).
 *
 * Loading pattern mirrors utils/match.js: a plain script that assigns a single
 * namespace object. It is listed BEFORE the site script in manifest
 * content_scripts, and importScripts()'d at the top of background.js. We attach
 * to `self` so the same file works in both a content-script realm (self ===
 * window) and the service-worker realm (self === the SW global). Idempotent:
 * background can re-inject linkedin via chrome.scripting.executeScript.
 */

;(function () {
  const g = typeof self !== 'undefined' ? self : this
  if (!g || g.JobSwiperShared) return

  const API_BASE = 'https://www.jobswiper.ai'

  function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeoutMs)
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
  }

  // HTML-escape for innerHTML interpolation. Uses document, so it is only ever
  // called from a content-script context (never from the service worker).
  function esc(str) {
    const d = document.createElement('div')
    d.textContent = str
    return d.innerHTML
  }

  // Current extension version, read from the manifest. Used for the
  // X-JobSwiper-Ext-Version request header so the app can log which build a
  // request came from.
  function extVersion() {
    try { return chrome.runtime.getManifest().version } catch { return '' }
  }

  // Ask the background service worker for a VALID access token. The SW's
  // getValidToken() refreshes the Supabase token when it is about to expire, so
  // badge/analysis fetches keep working past the 1h access-token TTL instead of
  // silently dying. Returns null when logged out or the SW is unreachable.
  async function requestValidToken() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_AUTH' })
      return res?.token || null
    } catch {
      return null
    }
  }

  // Single analyze-job request shape shared by every site script. Returns the
  // HTTP status alongside the parsed body so callers can render an honest state
  // on 401 (re-auth) / 429 (rate limited) instead of just dropping the badge.
  // NOTE: no custom request header is added here on purpose. This runs in a
  // content-script (cross-origin) context, and the app's analyze-job CORS
  // allow-list is only "Content-Type, Authorization"; a custom header would be
  // rejected at preflight. The version header is added on the CORS-exempt
  // background/popup requests instead (see background.js saveJob / refresh).
  async function analyzeJob(jobData, token, timeoutMs = 8000) {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/analyze-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(jobData),
    }, timeoutMs)
    let data = null
    try { data = await res.json() } catch {}
    return { ok: res.ok, status: res.status, data }
  }

  // Render a compact, honest badge state when analyze-job fails. 429 -> rate
  // limited (transient). 401/anything-auth -> re-auth prompt that opens login.
  // Shared so all four sites show the same thing instead of a silent removal.
  function renderBadgeIssue(badge, status) {
    if (!badge) return
    badge.textContent = ''
    badge.style.border = ''
    if (status === 429) {
      badge.style.background = '#fef3c7' // amber-100
      badge.style.color = '#92400e' // amber-800
      badge.style.cursor = 'default'
      badge.textContent = 'Rate limited'
      badge.setAttribute('title', 'Too many requests. Try again in a moment.')
      badge.onclick = null
      return
    }
    // 401 or any other auth failure: session expired.
    badge.style.background = '#fee2e2' // red-100
    badge.style.color = '#991b1b' // red-800
    badge.style.cursor = 'pointer'
    badge.textContent = 'Sign in'
    badge.setAttribute('title', 'Session expired. Click to re-open JobSwiper.')
    badge.onclick = () => { try { window.open(`${API_BASE}/login`, '_blank') } catch {} }
  }

  g.JobSwiperShared = {
    API_BASE,
    fetchWithTimeout,
    esc,
    extVersion,
    requestValidToken,
    analyzeJob,
    renderBadgeIssue,
  }
})()
