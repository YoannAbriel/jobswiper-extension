// Injected on jobswiper.ai — tells the app the extension is installed
const el = document.createElement('div')
el.id = 'jobswiper-extension-installed'
el.style.display = 'none'
document.documentElement.appendChild(el)

// Same-origin only: strict origin check on inbound + explicit targetOrigin on outbound
// Rationale: Brave + Firefox harden cross-origin postMessage. `*` works on Chrome but
// can be silently filtered elsewhere, and is unnecessarily permissive.
const ALLOWED_ORIGIN = window.location.origin

// The extension context is invalidated when the extension is reloaded or updated
// while this page stays open; any chrome.* call from the now-orphaned content
// script then throws "Extension context invalidated". Guard every chrome call so
// an orphaned instance fails silently (a page refresh re-injects a fresh script).
function extAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id) } catch (e) { return false }
}
function safeSend(message, cb) {
  if (!extAlive()) { if (cb) cb(null); return }
  try {
    chrome.runtime.sendMessage(message, (resp) => {
      void chrome.runtime.lastError
      if (cb) cb(resp)
    })
  } catch (e) { if (cb) cb(null) }
}

window.addEventListener('message', (event) => {
  if (event.origin !== ALLOWED_ORIGIN) return
  if (event.source !== window) return

  // Detection ping
  if (event.data?.type === 'JOBSWIPER_EXTENSION_PING') {
    window.postMessage({ type: 'JOBSWIPER_EXTENSION_PONG' }, ALLOWED_ORIGIN)
  }

  // Auth token transfer: routes through the SW (single-writer pattern)
  // so popup, detect, and the SW never race on chrome.storage.local
  // writes for the auth bundle.
  if (event.data?.type === 'JOBSWIPER_SET_TOKEN' && event.data.token) {
    const pull = event.data.pull_session === true
    if (pull) {
      // Never store the shared cookie refresh_token (refreshing it would rotate
      // and log the web app out). Just pull an INDEPENDENT session. We do NOT
      // STORE_AUTH the access token here: writing refresh_token:null first would
      // defeat pullIndependentSession's dedup (it skips minting only while a
      // fresh independent refresh_token is still present), causing a fresh mint
      // on every page load. pullIndependentSession keeps the existing session
      // when still valid and mints only when needed.
      safeSend({ type: 'PULL_SESSION' }, () => {
        window.postMessage({ type: 'JOBSWIPER_TOKEN_SAVED' }, ALLOWED_ORIGIN)
      })
      return
    }
    // Old app builds do not send the flag: store the shared refresh_token as
    // before (no regression for already-installed extensions on the old app).
    safeSend(
      {
        type: 'STORE_AUTH',
        token: event.data.token,
        refresh_token: event.data.refresh_token ?? null,
        expires_at: event.data.expires_at ?? null,
      },
      () => {
        window.postMessage({ type: 'JOBSWIPER_TOKEN_SAVED' }, ALLOWED_ORIGIN)
      },
    )
  }

  // Logout from web: clear all extension auth state. Sent on
  // supabase.auth SIGNED_OUT and on explicit account deletion.
  if (event.data?.type === 'JOBSWIPER_LOGOUT') {
    safeSend({ type: 'LOGOUT' })
  }

  // Profile data sync: app sends profile for autofill (also via SW)
  if (event.data?.type === 'JOBSWIPER_SET_PROFILE' && event.data.profile) {
    safeSend({ type: 'STORE_PROFILE', profile: event.data.profile })
  }

  // Auth token request: app asks extension for current token
  if (event.data?.type === 'JOBSWIPER_GET_TOKEN') {
    if (!extAlive()) {
      window.postMessage({ type: 'JOBSWIPER_TOKEN_RESULT', token: null }, ALLOWED_ORIGIN)
      return
    }
    try {
      chrome.storage.local.get('token', ({ token }) => {
        window.postMessage({ type: 'JOBSWIPER_TOKEN_RESULT', token: token || null }, ALLOWED_ORIGIN)
      })
    } catch (e) {
      window.postMessage({ type: 'JOBSWIPER_TOKEN_RESULT', token: null }, ALLOWED_ORIGIN)
    }
  }
})
