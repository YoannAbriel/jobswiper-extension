/**
 * JobSwiper Extension — Popup with robust auth flow
 *
 * 1. User logs in on jobswiper.ai
 * 2. Clicks "Connect" in popup → calls /api/extension/auth (uses cookies)
 * 3. Gets fresh token → stored in chrome.storage
 * 4. Token used for all subsequent API calls
 */

const API_BASE = 'https://www.jobswiper.ai'

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
}

document.addEventListener('DOMContentLoaded', async () => {
  // First: try auto-connect (scan open tabs for JobSwiper)
  try {
    const result = await chrome.runtime.sendMessage({ type: 'AUTO_CONNECT' })
    if (result?.success && result.token) {
      showLoggedIn(result.token)
      return
    }
  } catch {}

  // Check stored token
  const { token } = await chrome.storage.local.get('token')
  if (token) {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/extension/stats`, {
        headers: { 'Authorization': `Bearer ${token}` },
      }, 8000)
      if (res.ok) { showLoggedIn(token); return }
    } catch {}
    await chrome.storage.local.remove('token')
  }

  showLoggedOut()
})

function showLoggedIn(token) {
  document.body.classList.remove('logged-out')
  document.body.classList.add('logged-in')
  loadStats(token)
}

function showLoggedOut() {
  document.body.classList.remove('logged-in')
  document.body.classList.add('logged-out')
}

// Connect button — tries auto-connect (tab scan) then cookie fallback
document.getElementById('connect-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('connect-btn')
  const origText = btn.textContent
  btn.textContent = 'Connecting...'
  btn.disabled = true

  // Try 1: auto-connect via open tab (reads localStorage)
  try {
    const result = await chrome.runtime.sendMessage({ type: 'AUTO_CONNECT' })
    if (result?.success && result.token) {
      showLoggedIn(result.token)
      return
    }
  } catch {}

  // Try 2: cookie-based auth endpoint
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/auth`, {
      credentials: 'include',
    }, 10000)
    if (res.ok) {
      const data = await res.json()
      if (data.token) {
        await chrome.storage.local.set({ token: data.token })
        showLoggedIn(data.token)
        return
      }
    }
  } catch {}

  btn.textContent = 'Open JobSwiper & log in first'
  setTimeout(() => { btn.textContent = origText; btn.disabled = false }, 3000)
})

// Logout
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  await chrome.storage.local.remove('token')
  showLoggedOut()
})

async function loadStats(token) {
  const statsEl = document.getElementById('stats')
  const recentEl = document.getElementById('recent-saves')
  if (!statsEl) return

  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/stats`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }, 8000)

    if (!res.ok) {
      if (res.status === 401) { await chrome.storage.local.remove('token'); showLoggedOut() }
      return
    }

    const data = await res.json()

    statsEl.innerHTML = `
      <div class="stat"><div class="stat-num">${data.saved}</div><div class="stat-label">Saved</div></div>
      <div class="stat"><div class="stat-num">${data.applied}</div><div class="stat-label">Applied</div></div>
    `

    const profileEl = document.getElementById('profile-bar')
    if (profileEl) {
      const pct = data.profile_completeness
      const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444'
      profileEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:11px;font-weight:600;color:#4b5563">Profile</span>
          <span style="font-size:11px;color:#9ca3af">${pct}%</span>
        </div>
        <div style="height:4px;background:#e5e7eb;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div>
        </div>
      `
    }

    if (recentEl && data.recent_saves?.length > 0) {
      recentEl.innerHTML = data.recent_saves.map(s => `
        <div class="recent-item">
          <div class="recent-title">${esc(s.title)}</div>
          <div class="recent-company">${esc(s.company)}</div>
        </div>
      `).join('')
    } else if (recentEl) {
      recentEl.innerHTML = '<div style="text-align:center;color:#9ca3af;font-size:11px;padding:8px">No saved jobs yet</div>'
    }
  } catch {
    statsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;font-size:11px">Could not load stats</div>'
  }
}
