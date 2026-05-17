/**
 * JobSwiper Extension — Background Service Worker
 * Handles API calls to JobSwiper backend.
 */

const API_BASE = 'https://www.jobswiper.ai'

// Refresh the access token when it has less than this many seconds left.
// 120s buys enough headroom that a slow saveJob fetch still completes
// against a still-valid token even after the SW yields between
// getValidToken() and the actual fetch.
const REFRESH_THRESHOLD_SECONDS = 120

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
}

// ── Auto-connect: find open JobSwiper tab and grab token ──

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, 8000)
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.token) return null
    return {
      token: data.token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
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
        await chrome.storage.local.set({
          token: refreshed.token,
          refresh_token: refreshed.refresh_token,
          expires_at: refreshed.expires_at,
        })
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
  await chrome.storage.local.remove(['token', 'refresh_token', 'expires_at', 'userProfile'])
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
      title: 'JobSwiper installed',
      message: "Open any job on LinkedIn, Indeed, or JobUp and it'll save automatically.",
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
            files: ['utils/match.js', 'content/linkedin.js'],
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
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    try {
      switch (message?.type) {
        case 'AUTO_CONNECT': {
          await autoConnect()
          const token = await getValidToken()
          sendResponse({ success: !!token, token })
          return
        }
        case 'SAVE_JOB': {
          // Refresh the access token if it is about to expire so the user
          // does not get silently logged out after the 1h Supabase TTL.
          const token = await getValidToken()
          if (!token) {
            sendResponse({ success: false, error: 'Authentication required' })
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
        case 'LOGOUT': {
          await clearAuthState()
          sendResponse({ success: true })
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
    title: 'JobSwiper Reminder',
    message: `You saved "${reminder.title}" at ${reminder.company} 3 days ago. Ready to apply?`,
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
    },
    body: JSON.stringify(jobData),
  }, 15000)

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }

  return await response.json()
}
