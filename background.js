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
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }))
    return true // Keep channel open for async response
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
