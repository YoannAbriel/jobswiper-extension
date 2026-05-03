/**
 * JobSwiper Content Script — LinkedIn
 *
 * Strategy: inject a persistent bar into the stable wrapper div
 * (.jobs-search__job-details--wrapper) which React never replaces.
 * On job change, we just update the button state — no remove/re-inject cycle.
 */

const API_BASE = 'https://www.jobswiper.ai'

// YOA-188: bounded ring buffer of injection events stored in chrome.storage.local.
// Lets future test sessions inspect why an injection failed without depending on
// verbal reports. Read with: chrome.storage.local.get('jobswiper:linkedin:log').
const _LOG_KEY = 'jobswiper:linkedin:log'
const _LOG_MAX = 200
function _logInjection(outcome, extra) {
  try {
    if (!chrome.runtime?.id || !chrome.storage?.local) return
    const entry = {
      ts: Date.now(),
      url: location.pathname + location.search,
      outcome,
      ...(extra || {}),
    }
    chrome.storage.local.get(_LOG_KEY, (res) => {
      const entries = Array.isArray(res[_LOG_KEY]) ? res[_LOG_KEY] : []
      entries.push(entry)
      chrome.storage.local.set({ [_LOG_KEY]: entries.slice(-_LOG_MAX) })
    })
    console.log('[jobswiper:log]', JSON.stringify(entry))
    // Only the terminal 'gave-up' outcome is worth shipping back to the
    // backend: it means the retry budget was fully exhausted and the user
    // did not get a save bar on this navigation. Everything else is noise.
    if (outcome === 'gave-up') _reportInjectionFailure(entry)
  } catch {}
}

function _reportInjectionFailure(entry) {
  try {
    fetch(`${API_BASE}/api/extension/inject-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: entry.outcome,
        attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
        pathname: location.pathname,
      }),
      keepalive: true,
    }).catch(() => {})
  } catch {}
}


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

  // Location: first .tvm__text in the tertiary description container (e.g. "Genève, Suisse")
  const tertiaryDesc = document.querySelector('.job-details-jobs-unified-top-card__tertiary-description-container') ||
    document.querySelector('.jobs-unified-top-card__subtitle')
  if (tertiaryDesc) {
    const firstSpan = tertiaryDesc.querySelector('.tvm__text--low-emphasis')
    data.location = firstSpan?.textContent?.trim() || ''
  }
  if (!data.location) {
    data.location = (
      document.querySelector('.job-details-jobs-unified-top-card__bullet')?.textContent ||
      document.querySelector('.jobs-unified-top-card__bullet')?.textContent ||
      document.querySelector('.topcard__flavor--bullet')?.textContent ||
      ''
    ).trim()
  }

  data.description = (
    document.querySelector('.jobs-description-content__text')?.innerText ||
    document.querySelector('.jobs-description__content')?.innerText ||
    document.querySelector('.jobs-box__html-content')?.innerText ||
    document.querySelector('#job-details')?.innerText ||
    document.querySelector('[class*="jobs-description"]')?.innerText ||
    ''
  ).trim()

  // Job type & remote: check both insights and fit-level-preferences buttons
  const typeElements = document.querySelectorAll(
    '.jobs-unified-top-card__job-insight, .job-details-jobs-unified-top-card__job-insight, .job-details-fit-level-preferences button'
  )
  for (const el of typeElements) {
    const text = el.textContent?.toLowerCase().trim() || ''
    if (!data.job_type) {
      if (text.includes('full-time') || text.includes('temps plein')) data.job_type = 'Full-time'
      else if (text.includes('part-time') || text.includes('temps partiel')) data.job_type = 'Part-time'
      else if (text.includes('contract') || text.includes('contrat') || text.includes('cdd')) data.job_type = 'Contract'
      else if (text.includes('internship') || text.includes('stage') || text.includes('alternance')) data.job_type = 'Internship'
      else if (text.includes('freelance') || text.includes('indépendant')) data.job_type = 'Freelance'
    }
    if (text.includes('remote') || text.includes('à distance') || text.includes('télétravail')) data.is_remote = true
    if (text.includes('hybride') || text.includes('hybrid')) data.is_remote = false
    if (text.includes('sur site') || text.includes('on-site')) data.is_remote = false
  }

  // Build canonical LinkedIn job URL: /jobs/view/XXXXXXX/
  // Use getLinkedInJobId() which is robust and avoids matching wrong links in the sidebar
  const detectedJobId = getLinkedInJobId()
  if (detectedJobId) {
    data.url = `https://www.linkedin.com/jobs/view/${detectedJobId}/`
  } else {
    // No job ID found — generate a unique URL to avoid dedup collisions
    const slug = (data.title + '-' + data.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 80)
    const uid = Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
    data.url = `https://www.linkedin.com/extension-import/${slug}-${uid}`
  }
  data.source = 'linkedin'

  // Company logo
  const logo = document.querySelector('.job-details-jobs-unified-top-card__container--two-pane img[class*="EntityPhoto"]') ||
    document.querySelector('.job-details-jobs-unified-top-card__company-logo img') ||
    document.querySelector('.jobs-unified-top-card__company-logo img') ||
    document.querySelector('.artdeco-entity-lockup__image img[title]')
  if (logo?.src && !logo.src.includes('data:image/gif')) data.company_logo = logo.src

  // Salary — LinkedIn shows it inside #SALARY container or in job insights
  const salaryContainer = document.querySelector('#SALARY')
  if (salaryContainer) {
    // Look for salary text inside the container itself, not its sibling
    const salarySpans = salaryContainer.querySelectorAll('span, div')
    for (const s of salarySpans) {
      const t = s.textContent?.trim() || ''
      if (t.match(/[\d.,]+\s*[€$£CHF]|[€$£]\s*[\d.,]+|[\d.,]+\s*[kK]\s*[-–]/)) {
        data.salary_range = t.substring(0, 100)
        break
      }
    }
  }
  // Also check insights for salary mentions
  if (!data.salary_range) {
    const allInsights = document.querySelectorAll('.job-details-jobs-unified-top-card__job-insight span')
    for (const s of allInsights) {
      const t = s.textContent?.trim() || ''
      if (t.match(/[\d.,]+\s*[€$£CHF]|[€$£]\s*[\d.,]+|[\d.,]+\s*[kK]\s*[-–]/)) {
        data.salary_range = t.substring(0, 100)
        break
      }
    }
  }

  // Posted date — "il y a 1 semaine", "il y a 3 jours", etc.
  if (tertiaryDesc) {
    const allSpans = tertiaryDesc.querySelectorAll('.tvm__text--low-emphasis')
    for (const span of allSpans) {
      const t = span.textContent?.trim() || ''
      if (t.includes('il y a') || t.includes('ago') || t.includes('jour') || t.includes('semaine') || t.includes('mois') || t.includes('day') || t.includes('week') || t.includes('month') || t.includes('hour') || t.includes('heure')) {
        data.posted_date = t
        break
      }
    }
  }

  // Company info section — size, industry, description, website
  const companyBox = document.querySelector('.jobs-company__box') || document.querySelector('[data-view-name="job-details-about-company-module"]')
  if (companyBox) {
    // Industry + size: "Services et conseil en informatique · 1 001-5 000 employés"
    const infoLine = companyBox.querySelector('.t-14.mt5')
    if (infoLine) {
      // Industry is the direct text content (not inside child spans)
      // Split full text by the inline-information spans
      const fullText = infoLine.textContent?.trim() || ''
      // Get text before the first span (that's the industry)
      const spans = infoLine.querySelectorAll('.jobs-company__inline-information')
      let industryText = fullText
      for (const s of spans) {
        industryText = industryText.replace(s.textContent || '', '')
      }
      industryText = industryText.trim().replace(/\s+/g, ' ')
      if (industryText && industryText.length > 2 && !industryText.includes('employés') && !industryText.includes('employees')) {
        data.industry = industryText
      }
      // Company size from spans
      const sizeSpans = infoLine.querySelectorAll('.jobs-company__inline-information')
      for (const s of sizeSpans) {
        const st = s.textContent?.trim() || ''
        if (st.includes('employé') || st.includes('employee')) {
          data.company_size = st
        }
      }
    }

    // Company description
    const descEl = companyBox.querySelector('.inline-show-more-text') || companyBox.querySelector('.jobs-company__company-description')
    if (descEl) {
      data.company_description = descEl.textContent?.trim().substring(0, 500) || ''
    }

    // Company LinkedIn URL
    const companyLink = companyBox.querySelector('a[href*="/company/"]')
    if (companyLink?.href) {
      data.company_website = companyLink.href.split('?')[0]
    }
  }

  // Number of applicants
  if (tertiaryDesc) {
    const text = tertiaryDesc.textContent || ''
    const applicantMatch = text.match(/(\d+)\s*(?:autres?\s*personnes?|applicant|people|candidat)/i)
    if (applicantMatch) {
      data.applicant_count = parseInt(applicantMatch[1])
    }
  }

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
      btn.innerHTML = `${_beamHTML}✓ Saved!`
      const jobDetailUrl = response.likedJobId ? `${API_BASE}/dashboard/jobs/${response.likedJobId}` : `${API_BASE}/dashboard/jobs`
      showToast('Job saved!', jobDetailUrl)
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

const _beamHTML = '<div class="jobswiper-beam"><div></div></div>'

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `${_beamHTML}${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="16" height="16"></span> ` : ''}Save to JobSwiper`
}

// ============================================================================
// Persistent bar — injected ONCE into a stable wrapper, never removed
// ============================================================================

let _bar = null
let _barBtn = null
let _currentJobUrl = ''

// LinkedIn renames classes regularly (often with hash suffixes). Order: known
// stable names first, then substring-tolerant fallbacks. Returns null if none
// match, in which case the caller schedules a backoff retry.
function findTopCardAnchor() {
  return (
    document.querySelector('.job-details-jobs-unified-top-card__container--two-pane') ||
    document.querySelector('.jobs-unified-top-card__content--two-pane') ||
    document.querySelector('[class*="job-details-jobs-unified-top-card__container"]') ||
    document.querySelector('[class*="jobs-unified-top-card"][class*="two-pane"]') ||
    document.querySelector('.job-view-layout [class*="top-card"]')
  )
}

function getOrCreateBar() {
  // If bar already exists in DOM, reuse it
  if (_bar && document.body.contains(_bar)) return _bar

  const topCard = findTopCardAnchor()
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

// YOA-188: when the anchor is briefly missing right after a navigation, the
// 1.5s polling tick is too slow. Retry on a tighter exponential backoff and
// abandon after the last delay so we don't loop forever on a non-job page.
const _INJECT_RETRY_DELAYS = [200, 500, 1000, 2000, 4000]
let _retryAttempt = 0
let _retryTimer = null
function resetRetry() {
  _retryAttempt = 0
  if (_retryTimer) {
    clearTimeout(_retryTimer)
    _retryTimer = null
  }
}
function scheduleInjectRetry() {
  if (_retryTimer) return
  if (_retryAttempt >= _INJECT_RETRY_DELAYS.length) {
    _logInjection('gave-up', { attempts: _retryAttempt })
    return
  }
  const delay = _INJECT_RETRY_DELAYS[_retryAttempt++]
  _retryTimer = setTimeout(() => {
    _retryTimer = null
    if (!chrome.runtime?.id) return
    if (!isJobPage()) {
      resetRetry()
      return
    }
    if (_bar && document.body.contains(_bar)) {
      resetRetry()
      return
    }
    if (getOrCreateBar()) {
      _logInjection('injected-via-retry', { attempt: _retryAttempt })
      resetRetry()
      updateBar()
    } else {
      scheduleInjectRetry()
    }
  }, delay)
}

function getLinkedInJobId() {
  // Method 1: currentJobId URL param (LinkedIn uses this on search/collections pages)
  const urlParam = new URLSearchParams(window.location.search).get('currentJobId')
  if (urlParam) return urlParam

  // Method 2: job ID from the URL path (/jobs/view/XXXXXXX/)
  const pathMatch = window.location.pathname.match(/\/jobs\/view\/(\d+)/)
  if (pathMatch) return pathMatch[1]

  // Method 3: job title link in the detail panel ONLY (not sidebar cards)
  const titleLink = document.querySelector('.job-details-jobs-unified-top-card__job-title a[href*="/jobs/view/"]') ||
    document.querySelector('h1.t-24 a[href*="/jobs/view/"]')
  const linkMatch = titleLink?.href?.match(/\/jobs\/view\/(\d+)/)
  if (linkMatch) return linkMatch[1]

  return ''
}

function updateBar() {
  const currentId = getLinkedInJobId()

  // Can't identify job — don't touch anything (avoids resetting "Saved!" state)
  if (!currentId) {
    if (!_bar || !document.body.contains(_bar)) {
      if (!getOrCreateBar()) {
        _logInjection('no-anchor', { stage: 'no-id' })
        scheduleInjectRetry()
      }
    }
    return
  }

  // Same job — nothing to do
  if (currentId === _currentJobUrl && _bar && document.body.contains(_bar)) return

  _currentJobUrl = currentId

  // Ensure bar exists
  if (!getOrCreateBar()) {
    _logInjection('no-anchor', { stage: 'have-id', jobId: currentId })
    scheduleInjectRetry()
    return
  }

  resetRetry()
  _logInjection('injected', { jobId: currentId })

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

if (!window.__jobswiper_linkedin_loaded) {
  window.__jobswiper_linkedin_loaded = true
  _logInjection('script-loaded')

  // Coalesce bursts of mutations + nav events into a single tick.
  // Without the flag, multiple requestAnimationFrame(cb) registrations in
  // the same frame each fire next tick (rAF does not auto-dedupe).
  // When the tab is hidden, rAF is paused, so fall back to setTimeout so
  // an SPA navigation while backgrounded still updates state.
  let _scheduled = false
  function scheduleUpdate() {
    if (_scheduled) return
    _scheduled = true
    const run = () => {
      _scheduled = false
      if (!chrome.runtime?.id) return
      try {
        attachObserver()
        if (isJobPage()) {
          updateBar()
        } else if (_bar && document.body.contains(_bar)) {
          _bar.remove()
          _bar = null
          _currentJobUrl = ''
          resetRetry()
        }
      } catch {
        // Extension context invalidated mid-tick
      }
    }
    if (document.hidden) setTimeout(run, 0)
    else requestAnimationFrame(run)
  }

  // Each fresh navigation gets its own retry budget; otherwise an SPA hop
  // would inherit the previous URL's exhausted attempt count.
  function onNavSignal() {
    resetRetry()
    scheduleUpdate()
  }

  // The MAIN-world script (linkedin-main.js) patches history.pushState
  // there and dispatches this event. Patching from the isolated world is a
  // no-op because each world has its own window.history copy.
  window.addEventListener('jobswiper:locationchange', onNavSignal)

  // Background relay (chrome.webNavigation.onHistoryStateUpdated): a
  // belt-and-braces second source of nav signals.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'LINKEDIN_NAV') onNavSignal()
    })
  } catch {
    // Extension context invalidated
  }

  // Re-resolve the observer root on each tick of scheduleUpdate: LinkedIn
  // re-mounts .scaffold-layout occasionally and a stale observer would
  // silently stop emitting. Falls back to body until scaffold-layout exists.
  let _mo = null
  let _moRoot = null
  function attachObserver() {
    if (!chrome.runtime?.id || typeof MutationObserver !== 'function') return
    const root = document.querySelector('.scaffold-layout') ?? document.body
    if (!root || root === _moRoot) return
    _mo?.disconnect()
    _mo = new MutationObserver(scheduleUpdate)
    _mo.observe(root, { childList: true, subtree: true })
    _moRoot = root
  }
  attachObserver()
  scheduleUpdate()

  // Safety net for cases all signals miss (very rare).
  setInterval(scheduleUpdate, 1500)
}
