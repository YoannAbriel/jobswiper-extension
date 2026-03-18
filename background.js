/**
 * JobSwiper Extension — Background Service Worker
 * Handles API calls to JobSwiper backend.
 */

// const API_BASE = 'https://www.jobswiper.ai' // Production
const API_BASE = 'http://localhost:3001' // Dev

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_JOB') {
    saveJob(message.data, message.token)
      .then(result => {
        // Schedule reminder if new save
        if (result.success && !result.alreadyLiked) {
          scheduleReminder(message.data.title, message.data.company)
        }
        sendResponse(result)
      })
      .catch(err => sendResponse({ success: false, error: err.message }))
    return true
  }

  if (message.type === 'CHECK_AUTH') {
    chrome.storage.local.get('token', ({ token }) => {
      sendResponse({ authenticated: !!token, token })
    })
    return true
  }

  if (message.type === 'SET_TOKEN') {
    chrome.storage.local.set({ token: message.token }, () => {
      sendResponse({ success: true })
    })
    return true
  }

  if (message.type === 'LOGOUT') {
    chrome.storage.local.remove('token', () => {
      sendResponse({ success: true })
    })
    return true
  }
})

// ── Reminder notifications ──────────────────────────

// Set a reminder when a job is saved
function scheduleReminder(jobTitle, jobCompany) {
  const alarmName = `reminder-${Date.now()}`
  // Remind in 3 days
  chrome.alarms.create(alarmName, { delayInMinutes: 60 * 24 * 3 })
  // Store reminder data
  chrome.storage.local.get('reminders', ({ reminders = [] }) => {
    reminders.push({ alarm: alarmName, title: jobTitle, company: jobCompany, created: Date.now() })
    // Keep max 20 reminders
    if (reminders.length > 20) reminders = reminders.slice(-20)
    chrome.storage.local.set({ reminders })
  })
}

// Handle alarm fire
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('reminder-')) return
  chrome.storage.local.get('reminders', ({ reminders = [] }) => {
    const reminder = reminders.find(r => r.alarm === alarm.name)
    if (reminder) {
      chrome.notifications.create(alarm.name, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'JobSwiper Reminder',
        message: `You saved "${reminder.title}" at ${reminder.company} 3 days ago. Ready to apply?`,
        buttons: [{ title: 'Open JobSwiper' }],
        priority: 1,
      })
      // Remove from stored reminders
      const updated = reminders.filter(r => r.alarm !== alarm.name)
      chrome.storage.local.set({ reminders: updated })
    }
  })
})

// Handle notification click
chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${API_BASE}/dashboard/jobs` })
})

async function saveJob(jobData, token) {
  const response = await fetch(`${API_BASE}/api/extension/import-job`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(jobData),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }

  return await response.json()
}
