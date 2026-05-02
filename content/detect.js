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

  // Auth token transfer: app sends token (and optional refresh_token +
  // expires_at) to the extension after login or token refresh.
  if (event.data?.type === 'JOBSWIPER_SET_TOKEN' && event.data.token) {
    const update = { token: event.data.token }
    if (event.data.refresh_token) update.refresh_token = event.data.refresh_token
    if (event.data.expires_at) update.expires_at = event.data.expires_at
    chrome.storage.local.set(update, () => {
      window.postMessage({ type: 'JOBSWIPER_TOKEN_SAVED' }, ALLOWED_ORIGIN)
    })
  }

  // Logout from web: clear all extension auth state. Sent on
  // supabase.auth SIGNED_OUT and on explicit account deletion.
  if (event.data?.type === 'JOBSWIPER_LOGOUT') {
    chrome.runtime.sendMessage({ type: 'LOGOUT' }, () => void chrome.runtime.lastError)
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
