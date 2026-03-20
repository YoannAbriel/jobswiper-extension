/**
 * JobSwiper Content Script — LinkedIn
 */

// const API_BASE = 'https://www.jobswiper.ai' // Production
const API_BASE = 'http://localhost:3000' // Dev

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
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

  // LinkedIn shows job type in the insights
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

  // Company logo
  const logo = document.querySelector('.job-details-jobs-unified-top-card__company-logo img') ||
    document.querySelector('.artdeco-entity-image[data-ghost-url]')
  if (logo?.src) data.company_logo = logo.src

  return data
}

function createSaveButton() {
  const btn = document.createElement('button')
  btn.className = 'jobswiper-save-btn'
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
    </svg>
    Save to JobSwiper
  `
  return btn
}

function showToast(msg, link) {
  const existing = document.querySelector('.jobswiper-toast')
  if (existing) existing.remove()
  const toast = document.createElement('div')
  toast.className = 'jobswiper-toast'
  toast.innerHTML = msg
  if (link) toast.innerHTML += `<a href="${link}" target="_blank">Open</a>`
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

    // No token — try auto-connect before giving up
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
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.285 2l-11.285 11.567-5.286-5.011-3.714 3.716 9 8.728 15-15.285z"/></svg> Saved!`
      showToast('✅ Job saved!', API_BASE + '/dashboard/jobs')
      return
    }

    if (response && response.error && response.error.includes('Authentication') && retryCount < 2) {
      // Token expired — try to get a fresh one and retry
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

    // Other error — retry once
    if (response && !response.success && retryCount < 1) {
      console.log('[JobSwiper] Save failed, retrying...', response?.error)
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }

    btn.innerHTML = '❌ ' + (response?.error || 'Failed')
    setTimeout(() => resetButton(btn), 2000)
  } catch (err) {
    // Network error — retry once
    if (retryCount < 1) {
      console.log('[JobSwiper] Network error, retrying...', err.message)
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }
    console.error('[JobSwiper] Save error:', err)
    btn.innerHTML = '❌ ' + (err.message || 'Error')
    showToast('Error: ' + (err.message || 'Could not connect to JobSwiper'))
    setTimeout(() => resetButton(btn), 3000)
  }
}

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save to JobSwiper`
}

function injectButton() {
  if (document.querySelector('.jobswiper-save-btn')) return

  // Detect job detail: URL path or presence of description/details container
  const isJobDetail = window.location.pathname.includes('/jobs/view') ||
    window.location.pathname.includes('/jobs/collections') ||
    document.querySelector('.jobs-description-content__text') ||
    document.querySelector('.jobs-description__content') ||
    document.querySelector('#job-details') ||
    document.querySelector('[class*="jobs-description"]') ||
    document.querySelector('.job-view-layout')

  if (!isJobDetail) return

  const btn = createSaveButton()
  btn.addEventListener('click', () => handleSave(btn))

  // Find the button row: div.mt4 > div.display-flex that contains Postuler + Enregistrer
  // Must wait for LinkedIn to render these — if not found, return and let poll retry
  const linkedinSaveBtn = document.querySelector('.mt4 > .display-flex > button.jobs-save-button')
    || document.querySelector('.mt4 button.jobs-save-button')

  if (linkedinSaveBtn) {
    // Insert inline next to Enregistrer
    linkedinSaveBtn.after(btn)
    btn.style.cssText += 'margin-left: 8px;'
  } else {
    // Buttons not rendered yet — don't use fixed fallback, poll will retry
    return
  }
}

// Initial injection
injectButton()

// Track current job URL to detect navigation within LinkedIn SPA
let _lastJobUrl = window.location.href
let _injectPending = false

// Poll every 2s — more reliable than MutationObserver for LinkedIn's SPA
setInterval(() => {
  try {
    const currentUrl = window.location.href

    // URL changed — new job selected
    if (currentUrl !== _lastJobUrl) {
      _lastJobUrl = currentUrl
      _injectPending = false
      document.querySelector('.jobswiper-save-btn')?.remove()
      // Wait for LinkedIn to render the new job panel
      setTimeout(() => injectButton(), 800)
      return
    }

    // Button missing (LinkedIn re-rendered) — debounce re-inject
    if (!document.querySelector('.jobswiper-save-btn')) {
      if (_injectPending) {
        // Second consecutive poll without button — safe to inject
        _injectPending = false
        injectButton()
      } else {
        // First miss — wait one more cycle to confirm it's not a transient re-render
        _injectPending = true
      }
    } else {
      _injectPending = false
    }
  } catch {
    // Extension context invalidated — silently stop
  }
}, 1000)
