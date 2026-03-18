/**
 * JobSwiper Extension — Popup Logic with Mini Dashboard
 */

// const API_BASE = 'https://www.jobswiper.ai'
const API_BASE = 'http://localhost:3001'

document.addEventListener('DOMContentLoaded', async () => {
  const { token } = await chrome.storage.local.get('token')

  if (token) {
    document.body.classList.remove('logged-out')
    document.body.classList.add('logged-in')
    loadStats(token)
  } else {
    document.body.classList.remove('logged-in')
    document.body.classList.add('logged-out')
  }

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await chrome.storage.local.remove('token')
    document.body.classList.remove('logged-in')
    document.body.classList.add('logged-out')
  })
})

async function loadStats(token) {
  const statsEl = document.getElementById('stats')
  const recentEl = document.getElementById('recent-saves')
  if (!statsEl) return

  try {
    const response = await fetch(`${API_BASE}/api/extension/stats`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired
        await chrome.storage.local.remove('token')
        document.body.classList.remove('logged-in')
        document.body.classList.add('logged-out')
        return
      }
      throw new Error('API error')
    }

    const data = await response.json()

    statsEl.innerHTML = `
      <div class="stat">
        <div class="stat-num">${data.saved}</div>
        <div class="stat-label">Saved</div>
      </div>
      <div class="stat">
        <div class="stat-num">${data.applied}</div>
        <div class="stat-label">Applied</div>
      </div>
      <div class="stat">
        <div class="stat-num">${data.interviews}</div>
        <div class="stat-label">Interviews</div>
      </div>
    `

    // Profile completeness
    const profileEl = document.getElementById('profile-bar')
    if (profileEl) {
      profileEl.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:11px;font-weight:600;color:#4b5563">Profile</span>
          <span style="font-size:11px;color:#9ca3af">${data.profile_completeness}%</span>
        </div>
        <div style="height:4px;background:#e5e7eb;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${data.profile_completeness}%;background:${data.profile_completeness >= 80 ? '#10b981' : data.profile_completeness >= 50 ? '#f59e0b' : '#ef4444'};border-radius:2px;transition:width 0.5s"></div>
        </div>
      `
    }

    // Recent saves
    if (recentEl && data.recent_saves?.length > 0) {
      recentEl.innerHTML = data.recent_saves.map(s => `
        <div class="recent-item">
          <div class="recent-title">${s.title}</div>
          <div class="recent-company">${s.company}</div>
        </div>
      `).join('')
    } else if (recentEl) {
      recentEl.innerHTML = '<div style="text-align:center;color:#9ca3af;font-size:11px;padding:8px">No saved jobs yet</div>'
    }

  } catch (err) {
    statsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;font-size:11px">Could not load stats</div>'
  }
}
