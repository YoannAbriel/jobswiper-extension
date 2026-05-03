/**
 * JobSwiper Content Script — Jobup.ch
 *
 * Strategy: inject a persistent bar approach (like LinkedIn) since Jobup
 * is not a SPA — each job detail is a full page load.
 * Polls every 1s for button injection in case page re-renders.
 */

const API_BASE = 'https://www.jobswiper.ai'


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

// ============================================================================
// Job data extraction
// ============================================================================

function extractJobData() {
  const data = {}

  // Title
  data.title = (
    document.querySelector('h2[data-cy="vacancy-title"]')?.textContent ||
    document.querySelector('h1')?.textContent ||
    ''
  ).trim()

  // Company — the .notranslate span inside the vacancy-logo area
  const logoArea = document.querySelector('[data-cy="vacancy-logo"]')
  data.company = (
    logoArea?.querySelector('.notranslate')?.textContent ||
    logoArea?.querySelector('span')?.textContent ||
    ''
  ).trim()

  // Location — last li in vacancy-info, or look for location-like items
  const vacancyInfoItems = document.querySelectorAll('[data-cy="vacancy-info"] li')
  if (vacancyInfoItems.length > 0) {
    // Location is typically the last item
    const lastItem = vacancyInfoItems[vacancyInfoItems.length - 1]
    data.location = (lastItem?.querySelector('span')?.textContent || lastItem?.textContent || '').trim()
  }
  if (!data.location) {
    data.location = ''
  }

  // Description
  data.description = (
    document.querySelector('[data-cy="vacancy-description"]')?.innerText ||
    ''
  ).trim()

  // Job type — e.g. "Permanent position"
  const contractEl = document.querySelector('[data-cy="info-contract"] span')
  if (contractEl) {
    const contractText = contractEl.textContent?.trim().toLowerCase() || ''
    if (contractText.includes('permanent') || contractText.includes('indéterminée') || contractText.includes('unbefristet')) {
      data.job_type = 'Full-time'
    } else if (contractText.includes('temporary') || contractText.includes('déterminée') || contractText.includes('befristet')) {
      data.job_type = 'Contract'
    } else if (contractText.includes('intern') || contractText.includes('stage') || contractText.includes('praktik')) {
      data.job_type = 'Internship'
    } else if (contractText.includes('freelance')) {
      data.job_type = 'Freelance'
    }
  }

  // Workload — e.g. "100%", "80-100%"
  const workloadEl = document.querySelector('[data-cy="info-workload"] span')
  if (workloadEl) {
    const workloadText = workloadEl.textContent?.trim() || ''
    if (workloadText) {
      // If workload is less than 100%, mark as part-time
      const match = workloadText.match(/(\d+)\s*[-–]?\s*(\d+)?%/)
      if (match) {
        const maxPercent = parseInt(match[2] || match[1])
        if (maxPercent < 100 && !data.job_type) {
          data.job_type = 'Part-time'
        }
      }
      data.workload = workloadText
    }
  }

  // Posted date
  const publicationEl = document.querySelector('[data-cy="info-publication"] span')
  if (publicationEl) {
    data.posted_date = publicationEl.textContent?.trim() || ''
  }

  // Remote detection from location or description
  const locationLower = (data.location || '').toLowerCase()
  const descriptionLower = (data.description || '').toLowerCase()
  data.is_remote = !!(
    locationLower.includes('remote') ||
    locationLower.includes('télétravail') ||
    locationLower.includes('homeoffice') ||
    locationLower.includes('home office') ||
    descriptionLower.includes('remote') ||
    descriptionLower.includes('télétravail') ||
    descriptionLower.includes('homeoffice')
  )

  // Salary estimate (usually requires login on Jobup)
  const salaryEl = document.querySelector('[data-cy="info-salary_estimate"]')
  if (salaryEl) {
    const salaryText = (salaryEl.querySelector('span')?.textContent || salaryEl.textContent || '').trim()
    if (salaryText && salaryText.match(/[\d.,]+\s*[€$£CHF]|[€$£]\s*[\d.,]+|[\d.,]+\s*[kK]\s*[-–]|CHF\s*[\d.,]+/i)) {
      data.salary_range = salaryText.substring(0, 100)
    }
  }

  // Build canonical URL using jobid query parameter
  // Works on both jobup.ch and jobs.ch (same platform)
  const origin = window.location.origin
  const urlParams = new URLSearchParams(window.location.search)
  const jobId = urlParams.get('jobid')
  if (jobId) {
    data.url = `${origin}/en/jobs/detail/${jobId}/`
  } else {
    const pathMatch = window.location.pathname.match(/\/(?:jobs|vacancies)\/(?:detail\/)?([a-f0-9-]+)/)
    if (pathMatch) {
      data.url = `${origin}/en/jobs/detail/${pathMatch[1]}/`
    } else {
      const slug = (data.title + '-' + data.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 80)
      const uid = Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
      data.url = `${origin}/extension-import/${slug}-${uid}`
    }
  }

  // Company logo from the picture element in the header
  const logoImg = document.querySelector('[data-cy="vacancy-logo"] picture img') ||
    document.querySelector('[data-cy="vacancy-logo"] img')
  if (logoImg?.src && !logoImg.src.includes('data:image')) data.company_logo = logoImg.src

  // Company info from the company section if present
  const companySection = document.querySelector('[data-cy="vacancy-company"]') ||
    document.querySelector('.company-profile') ||
    document.querySelector('[class*="company-info"]')
  if (companySection) {
    // Company description
    const companyDesc = companySection.querySelector('p, .company-description, [class*="description"]')
    if (companyDesc) {
      data.company_description = companyDesc.textContent?.trim().substring(0, 500) || ''
    }

    // Industry
    const industryEl = companySection.querySelector('[class*="industry"], [class*="sector"]')
    if (industryEl) {
      data.industry = industryEl.textContent?.trim() || ''
    }

    // Company size
    const sizeEl = companySection.querySelector('[class*="size"], [class*="employees"]')
    if (sizeEl) {
      data.company_size = sizeEl.textContent?.trim() || ''
    }
  }

  data.source = window.location.hostname.includes('jobs.ch') ? 'jobs.ch' : 'jobup'
  return data
}

// ============================================================================
// Toast
// ============================================================================

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

// ============================================================================
// Save handler with retry + token refresh
// ============================================================================

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

    // Use background worker for cross-origin requests (Manifest V3 requirement)
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', data: jobData, token })

    if (response && response.success) {
      btn.className = 'jobswiper-save-btn saved'
      btn.innerHTML = `${_beamHTML}✓ Saved!`
      const jobDetailUrl = response.likedJobId ? `${API_BASE}/dashboard/jobs/${response.likedJobId}` : `${API_BASE}/dashboard/jobs`
      showToast('Job saved!', jobDetailUrl)
      return
    }

    // Token expired — try to refresh and retry
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

    // Other error — retry once
    if (response && !response.success && retryCount < 1) {
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }

    btn.innerHTML = '❌ ' + esc(response?.error || 'Failed')
    setTimeout(() => resetButton(btn), 2000)
  } catch (err) {
    // Network error — retry once
    if (retryCount < 1) {
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }
    btn.innerHTML = '❌ ' + esc(err.message || 'Error')
    showToast('Error: ' + (err.message || 'Could not connect to JobSwiper'))
    setTimeout(() => resetButton(btn), 3000)
  }
}

// ============================================================================
// Button creation & reset
// ============================================================================

const _logoUrl = 'data:image/png;base64,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'

const _beamHTML = '<div class="jobswiper-beam"><div></div></div>'

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `${_beamHTML}${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="16" height="16"></span> ` : ''}Save to JobSwiper`
}

// ============================================================================
// Persistent bar — injected ONCE, polls to re-inject if DOM re-renders
// ============================================================================

let _bar = null
let _barBtn = null
let _currentJobUrl = ''

function getOrCreateBar() {
  // If bar already exists in DOM, reuse it
  if (_bar && document.body.contains(_bar)) return _bar

  // Desktop: insert after the bookmark/save button or inside the CTA header
  const bookmarkBtn = document.querySelector('[data-cy="bookmark-button-unchecked"]') ||
    document.querySelector('[data-cy="bookmark-button-checked"]')
  const ctaDesktop = document.querySelector('#vacancy-cta-header')
  const ctaMobile = document.querySelector('#vacancy-cta-mobile')

  // Pick an anchor point — prefer bookmark button, then CTA areas
  const anchor = bookmarkBtn || ctaDesktop || ctaMobile

  if (!anchor) return null

  _barBtn = document.createElement('button')
  _barBtn.className = 'jobswiper-save-btn'
  resetButton(_barBtn)
  _barBtn.addEventListener('click', () => handleSave(_barBtn))

  // Score badge next to button (tier styling applied once data arrives)
  const scoreBadge = document.createElement('span')
  scoreBadge.className = 'jobswiper-inline-score'
  scoreBadge.style.background = '#f4f4f5'
  scoreBadge.style.color = '#71717a'
  scoreBadge.textContent = '...'

  _bar = document.createElement('div')
  _bar.className = 'jobswiper-jobup-bar'
  _bar.style.cssText = 'padding: 8px 0; display: flex; align-items: center; gap: 10px;'
  _bar.appendChild(_barBtn)
  _bar.appendChild(scoreBadge)

  // Insert after the anchor element
  if (bookmarkBtn) {
    // Insert the bar after the bookmark button's parent container
    const btnParent = bookmarkBtn.closest('div') || bookmarkBtn.parentElement
    if (btnParent) {
      btnParent.parentElement.insertBefore(_bar, btnParent.nextSibling)
    } else {
      bookmarkBtn.after(_bar)
    }
  } else if (ctaDesktop) {
    ctaDesktop.appendChild(_bar)
  } else if (ctaMobile) {
    ctaMobile.appendChild(_bar)
  }

  // Fetch score for inline badge
  try {
    chrome.storage.local.get('token', ({ token }) => {
      if (!token) { scoreBadge.remove(); return }
      const jobData = extractJobData()
      fetchWithTimeout(`${API_BASE}/api/extension/analyze-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(jobData),
      }, 8000).then(r => r.json()).then(data => {
        const score = data.match_score
        if (score == null) { scoreBadge.remove(); return }

        window.JobSwiperMatch.applyMatchBadge(scoreBadge, score)
        window.JobSwiperMatch.attachExplanationPopover(scoreBadge, score, data)

        if (data.already_saved) {
          _barBtn.className = 'jobswiper-save-btn saved'
          _barBtn.innerHTML = `${_beamHTML}✓ Saved`
        }
      }).catch(() => scoreBadge.remove())
    })
  } catch { scoreBadge.remove() }

  return _bar
}

function getJobupJobId() {
  // Method 1: jobid query parameter
  const params = new URLSearchParams(window.location.search)
  const jobId = params.get('jobid')
  if (jobId) return jobId

  // Method 2: job ID from pathname (/en/jobs/detail/12345/)
  const pathMatch = window.location.pathname.match(/\/jobs\/detail\/(\d+)/)
  if (pathMatch) return pathMatch[1]

  return ''
}

function isJobPage() {
  // Check URL has jobid param OR is a detail page OR has vacancy elements
  const hasJobId = new URLSearchParams(window.location.search).has('jobid')
  return hasJobId ||
    window.location.pathname.includes('/jobs/detail') ||
    !!document.querySelector('[data-cy="vacancy-title"]') ||
    !!document.querySelector('[data-cy="vacancy-description"]')
}

function updateBar() {
  const currentId = getJobupJobId()

  // Can't identify job — still try to create bar
  if (!currentId) {
    if (!_bar || !document.body.contains(_bar)) getOrCreateBar()
    return
  }

  // Same job — nothing to do
  if (currentId === _currentJobUrl && _bar && document.body.contains(_bar)) return

  _currentJobUrl = currentId

  // Ensure bar exists
  getOrCreateBar()
}

// ============================================================================
// Detection & polling
// ============================================================================

// Initial injection
if (isJobPage()) updateBar()

// Poll every 1s — re-inject if page re-renders and bar is lost
setInterval(() => {
  try {
    if (isJobPage()) {
      updateBar()
      // Also check if bar was removed by page re-render
      if (!document.querySelector('.jobswiper-jobup-bar') && _currentJobUrl) {
        _bar = null
        getOrCreateBar()
      }
    } else if (_bar && document.body.contains(_bar)) {
      _bar.remove()
      _bar = null
      _currentJobUrl = ''
    }
  } catch {
    // Extension context invalidated — stop polling
  }
}, 1000)
