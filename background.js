/**
 * JobSwiper Extension — Background Service Worker
 * Handles API calls to JobSwiper backend.
 */

const API_BASE = 'https://www.jobswiper.ai'

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
                return data?.access_token || null
              } catch { return null }
            }
          }
          return null
        },
      })

      const accessToken = results?.[0]?.result
      if (accessToken) {
        await chrome.storage.local.set({ token: accessToken })
        console.log('[JobSwiper] Auto-connected via open tab')
        return
      }
    } catch {}
  }
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
          const { token } = await chrome.storage.local.get('token')
          sendResponse({ success: !!token, token })
          return
        }
        case 'SAVE_JOB': {
          const result = await saveJob(message.data, message.token)
          if (result.success && !result.alreadyLiked) {
            scheduleReminder(message.data.title, message.data.company)
          }
          sendResponse(result)
          return
        }
        case 'CHECK_AUTH': {
          const { token } = await chrome.storage.local.get('token')
          sendResponse({ authenticated: !!token, token })
          return
        }
        case 'SET_TOKEN': {
          await chrome.storage.local.set({ token: message.token })
          sendResponse({ success: true })
          return
        }
        case 'LOGOUT': {
          await chrome.storage.local.remove('token')
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
  chrome.notifications.create(alarm.name, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'JobSwiper Reminder',
    message: `You saved "${reminder.title}" at ${reminder.company} 3 days ago. Ready to apply?`,
    buttons: [{ title: 'Open JobSwiper' }],
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
