// Injected on jobswiper.ai — tells the app the extension is installed
const el = document.createElement('div')
el.id = 'jobswiper-extension-installed'
el.style.display = 'none'
document.documentElement.appendChild(el)

// Respond to postMessage pings
window.addEventListener('message', (event) => {
  // Detection ping
  if (event.data?.type === 'JOBSWIPER_EXTENSION_PING') {
    window.postMessage({ type: 'JOBSWIPER_EXTENSION_PONG' }, '*')
  }

  // Auth token transfer: app sends token to extension after login
  if (event.data?.type === 'JOBSWIPER_SET_TOKEN' && event.data.token) {
    chrome.storage.local.set({ token: event.data.token }, () => {
      window.postMessage({ type: 'JOBSWIPER_TOKEN_SAVED' }, '*')
    })
  }

  // Profile data sync: app sends profile for autofill
  if (event.data?.type === 'JOBSWIPER_SET_PROFILE' && event.data.profile) {
    chrome.storage.local.set({ userProfile: event.data.profile })
  }

  // Auth token request: app asks extension for current token
  if (event.data?.type === 'JOBSWIPER_GET_TOKEN') {
    chrome.storage.local.get('token', ({ token }) => {
      window.postMessage({ type: 'JOBSWIPER_TOKEN_RESULT', token: token || null }, '*')
    })
  }
})
