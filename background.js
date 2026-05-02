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

  const refreshed = await refreshAccessToken(refresh_token)
  if (refreshed) {
    await chrome.storage.local.set({
      token: refreshed.token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    })
    return refreshed.token
  }
  return token
}

async function clearAuthState() {
  await chrome.storage.local.remove(['token', 'refresh_token', 'expires_at', 'userProfile'])
}

// Run on install + service worker wake
autoConnect()
chrome.runtime.onInstalled.addListener(() => autoConnect())

// Relay LinkedIn SPA navigation events to the content script so it can re-render
// the save bar instantly instead of waiting for the polling tick.
if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener(
    (details) => {
      if (details.frameId !== 0) return
      chrome.tabs.sendMessage(details.tabId, { type: 'LINKEDIN_NAV', url: details.url }).catch(() => {})
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
          // before the STORE_AUTH path landed. Remove after one release.
          await chrome.storage.local.set({ token: message.token })
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
