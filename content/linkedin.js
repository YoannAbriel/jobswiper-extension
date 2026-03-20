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
      btn.innerHTML = `<img src="${_logoUrl}" width="16" height="16" style="border-radius:3px"> Saved!`
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

const _logoUrl = chrome.runtime.getURL('icons/icon16.png')

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `<img src="${_logoUrl}" width="16" height="16" style="border-radius:3px"> Save to JobSwiper`
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

  _bar = document.createElement('div')
  _bar.className = 'jobswiper-linkedin-bar'
  _bar.style.cssText = 'padding: 8px 0 0; display: flex; align-items: center; gap: 10px;'
  _bar.appendChild(_barBtn)

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
