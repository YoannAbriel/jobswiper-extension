// Injected on jobswiper.ai — tells the app the extension is installed
const el = document.createElement('div')
el.id = 'jobswiper-extension-installed'
el.style.display = 'none'
document.documentElement.appendChild(el)

// Same-origin only: strict origin check on inbound + explicit targetOrigin on outbound
// Rationale: Brave + Firefox harden cross-origin postMessage. `*` works on Chrome but
// can be silently filtered elsewhere, and is unnecessarily permissive.
const ALLOWED_ORIGIN = window.location.origin

window.addEventListener('message', (event) => {
  if (event.origin !== ALLOWED_ORIGIN) return
  if (event.source !== window) return

  // Detection ping
  if (event.data?.type === 'JOBSWIPER_EXTENSION_PING') {
    window.postMessage({ type: 'JOBSWIPER_EXTENSION_PONG' }, ALLOWED_ORIGIN)
  }

  // Auth token transfer: app sends token to extension after login
  if (event.data?.type === 'JOBSWIPER_SET_TOKEN' && event.data.token) {
    chrome.storage.local.set({ token: event.data.token }, () => {
      window.postMessage({ type: 'JOBSWIPER_TOKEN_SAVED' }, ALLOWED_ORIGIN)
    })
  }

  // Profile data sync: app sends profile for autofill
  if (event.data?.type === 'JOBSWIPER_SET_PROFILE' && event.data.profile) {
    chrome.storage.local.set({ userProfile: event.data.profile })
  }

  // Auth token request: app asks extension for current token
  if (event.data?.type === 'JOBSWIPER_GET_TOKEN') {
    chrome.storage.local.get('token', ({ token }) => {
      window.postMessage({ type: 'JOBSWIPER_TOKEN_RESULT', token: token || null }, ALLOWED_ORIGIN)
    })
  }
})
