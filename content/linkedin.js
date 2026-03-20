/**
 * JobSwiper Content Script — LinkedIn
 *
 * Strategy: inject a persistent bar into the stable wrapper div
 * (.jobs-search__job-details--wrapper) which React never replaces.
 * On job change, we just update the button state — no remove/re-inject cycle.
 */

// const API_BASE = 'https://www.jobswiper.ai' // Production
const API_BASE = 'http://localhost:3000' // Dev

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

function extractJobData() {
  const data = {}

  data.title = (
    document.querySelector('.job-details-jobs-unified-top-card__job-title')?.textContent ||
    document.querySelector('.jobs-unified-top-card__job-title')?.textContent ||
    document.querySelector('[class*="job-details"] h1')?.textContent ||
    document.querySelector('[class*="jobs-unified-top-card"] h1')?.textContent ||
    document.querySelector('h1.t-24')?.textContent ||
    document.querySelector('h2.t-24')?.textContent ||
    document.querySelector('.job-view-layout h1')?.textContent ||
    ''
  ).trim()

  data.company = (
    document.querySelector('.job-details-jobs-unified-top-card__company-name')?.textContent ||
    document.querySelector('.jobs-unified-top-card__company-name')?.textContent ||
    document.querySelector('[class*="job-details"] [class*="company-name"]')?.textContent ||
    document.querySelector('.topcard__org-name-link')?.textContent ||
    document.querySelector('.job-view-layout [class*="company"]')?.textContent ||
    ''
  ).trim()

  data.location = (
    document.querySelector('.job-details-jobs-unified-top-card__bullet')?.textContent ||
    document.querySelector('.jobs-unified-top-card__bullet')?.textContent ||
    document.querySelector('[class*="job-details"] [class*="bullet"]')?.textContent ||
    document.querySelector('.topcard__flavor--bullet')?.textContent ||
    ''
  ).trim()

  data.description = (
    document.querySelector('.jobs-description-content__text')?.innerText ||
    document.querySelector('.jobs-description__content')?.innerText ||
    document.querySelector('.jobs-box__html-content')?.innerText ||
    document.querySelector('#job-details')?.innerText ||
    document.querySelector('[class*="jobs-description"]')?.innerText ||
    ''
  ).trim()

  const insights = document.querySelectorAll('.jobs-unified-top-card__job-insight, .job-details-jobs-unified-top-card__job-insight')
  for (const insight of insights) {
    const text = insight.textContent?.toLowerCase() || ''
    if (text.includes('full-time') || text.includes('temps plein')) data.job_type = 'Full-time'
    else if (text.includes('part-time') || text.includes('temps partiel')) data.job_type = 'Part-time'
    else if (text.includes('contract') || text.includes('contrat')) data.job_type = 'Contract'
    else if (text.includes('internship') || text.includes('stage')) data.job_type = 'Internship'

    if (text.includes('remote') || text.includes('à distance')) data.is_remote = true
  }

  data.url = window.location.href.split('?')[0]
  data.source = 'linkedin'

  const logo = document.querySelector('.job-details-jobs-unified-top-card__company-logo img') ||
    document.querySelector('.artdeco-entity-image[data-ghost-url]')
  if (logo?.src) data.company_logo = logo.src

  return data
}

function showToast(msg, link) {
  const existing = document.querySelector('.jobswiper-toast')
  if (existing) existing.remove()
  const toast = document.createElement('div')
  toast.className = 'jobswiper-toast'
  toast.textContent = msg
  if (link) {
    const a = document.createElement('a')
    a.href = link
    a.target = '_blank'
    a.textContent = 'Open'
    toast.appendChild(document.createTextNode(' '))
    toast.appendChild(a)
  }
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

async function handleSave(btn, retryCount = 0) {
  btn.innerHTML = '<div class="spinner"></div> Saving...'
  btn.disabled = true

  const jobData = extractJobData()
  if (!jobData.title || !jobData.company) {
    btn.innerHTML = '⚠️ Could not extract job'
    setTimeout(() => resetButton(btn), 2000)
    return
  }

  try {
    let { token } = await chrome.storage.local.get('token')

    if (!token) {
      try {
        await chrome.runtime.sendMessage({ type: 'AUTO_CONNECT' })
        const result = await chrome.storage.local.get('token')
        token = result.token
      } catch {}
    }

    if (!token) {
      btn.innerHTML = '🔒 Log in first'
      showToast('Log in to JobSwiper first', API_BASE + '/login')
      setTimeout(() => resetButton(btn), 2000)
      return
    }

    const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', data: jobData, token })

    if (response && response.success) {
      btn.className = 'jobswiper-save-btn saved'
      btn.innerHTML = `${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="16" height="16"></span> ` : ''}Saved!`
      const w = btn.closest('.jobswiper-btn-wrap'); if (w) w.classList.add('saved')
      showToast('Job saved!', API_BASE + '/dashboard/jobs')
      return
    }

    if (response && response.error && response.error.includes('Authentication') && retryCount < 2) {
      await chrome.storage.local.remove('token')
      try {
        await chrome.runtime.sendMessage({ type: 'AUTO_CONNECT' })
        const result = await chrome.storage.local.get('token')
        if (result.token) {
          return handleSave(btn, retryCount + 1)
        }
      } catch {}
      btn.innerHTML = '🔒 Reconnect in popup'
      setTimeout(() => resetButton(btn), 3000)
      return
    }

    if (response && !response.success && retryCount < 1) {
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }

    btn.innerHTML = '❌ ' + esc(response?.error || 'Failed')
    setTimeout(() => resetButton(btn), 2000)
  } catch (err) {
    if (retryCount < 1) {
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }
    btn.innerHTML = '❌ ' + esc(err.message || 'Error')
    showToast('Error: ' + (err.message || 'Could not connect to JobSwiper'))
    setTimeout(() => resetButton(btn), 3000)
  }
}

const _logoUrl = 'data:image/png;base64,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'

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="16" height="16"></span> ` : ''}Save to JobSwiper`
  const wrap = btn.closest('.jobswiper-btn-wrap')
  if (wrap) wrap.classList.remove('saved')
}

// ============================================================================
// Persistent bar — injected ONCE into a stable wrapper, never removed
// ============================================================================

let _bar = null
let _barBtn = null
let _currentJobUrl = ''

function getOrCreateBar() {
  // If bar already exists in DOM, reuse it
  if (_bar && document.body.contains(_bar)) return _bar

  // Find the top card container — our bar goes right after it
  // This element is stable (React replaces its children, not the container itself)
  const topCard = document.querySelector('.job-details-jobs-unified-top-card__container--two-pane')
    || document.querySelector('.jobs-unified-top-card__content--two-pane')

  if (!topCard) return null

  _barBtn = document.createElement('button')
  _barBtn.className = 'jobswiper-save-btn'
  resetButton(_barBtn)
  _barBtn.addEventListener('click', () => handleSave(_barBtn))

  const btnWrap = document.createElement('div')
  btnWrap.className = 'jobswiper-btn-wrap'
  btnWrap.innerHTML = '<div class="jobswiper-beam"></div>'
  btnWrap.appendChild(_barBtn)

  _bar = document.createElement('div')
  _bar.className = 'jobswiper-linkedin-bar'
  _bar.style.cssText = 'padding: 8px 0 0; display: flex; align-items: center; gap: 10px;'
  _bar.appendChild(btnWrap)

  // Insert after the top card — below Postuler/Enregistrer, outside React's scope
  topCard.parentElement.insertBefore(_bar, topCard.nextSibling)
  return _bar
}

function updateBar() {
  const jobUrl = window.location.href.split('?')[0]

  // Same job — nothing to do
  if (jobUrl === _currentJobUrl && _bar && document.body.contains(_bar)) return

  _currentJobUrl = jobUrl

  // Ensure bar exists
  if (!getOrCreateBar()) return

  // Reset button state for new job
  resetButton(_barBtn)
}

// ============================================================================
// Detection & polling
// ============================================================================

function isJobPage() {
  return window.location.pathname.includes('/jobs/view') ||
    window.location.pathname.includes('/jobs/collections') ||
    document.querySelector('#job-details') ||
    document.querySelector('[class*="jobs-description"]') ||
    document.querySelector('.job-view-layout')
}

// Initial
if (isJobPage()) updateBar()

// Poll — only updates state, never removes/re-creates the bar
setInterval(() => {
  try {
    if (isJobPage()) {
      updateBar()
    } else if (_bar && document.body.contains(_bar)) {
      _bar.remove()
      _bar = null
      _currentJobUrl = ''
    }
  } catch {
    // Extension context invalidated
  }
}, 1000)
