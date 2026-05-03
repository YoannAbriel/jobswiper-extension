/**
 * JobSwiper Content Script — Welcome to the Jungle (WTTJ)
 *
 * Same approach as Indeed/LinkedIn:
 * - Detail page: "Save to JobSwiper" button + score badge
 * - Search results: "Save to JobSwiper" button on each card
 * - Poll for SPA navigation
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

const _logoUrl = 'data:image/png;base64,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'

const _beamHTML = '<div class="jobswiper-beam"><div></div></div>'

// ============================================================================
// Job data extraction — detail page
// ============================================================================

function getJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]')
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent)
      if (data['@type'] === 'JobPosting') return data
    } catch {}
  }
  return null
}

function extractJobData() {
  const data = {}

  // Try JSON-LD first (structured, reliable from DOM)
  const jsonLd = getJsonLd()
  if (jsonLd) {
    data.title = (jsonLd.title || '').trim()
    data.company = (jsonLd.hiringOrganization?.name || '').trim()
    const loc = jsonLd.jobLocation?.[0]?.address || jsonLd.jobLocation?.address
    if (loc) {
      data.location = [loc.addressLocality, loc.addressRegion, loc.addressCountry].filter(Boolean).join(', ')
    }
    const tmpDiv = document.createElement('div')
    tmpDiv.innerHTML = jsonLd.description || ''
    data.description = tmpDiv.textContent?.trim() || ''
    data.company_logo = jsonLd.hiringOrganization?.logo || ''
    data.industry = jsonLd.industry || ''
    const typeMap = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', INTERN: 'Internship', CONTRACTOR: 'Contract' }
    data.job_type = typeMap[jsonLd.employmentType] || ''
    if (jsonLd.datePosted) data.posted_date = jsonLd.datePosted
  }

  // DOM fallbacks
  if (!data.title) {
    data.title = (
      document.querySelector('[data-testid="job-metadata-block"] h2')?.textContent ||
      document.querySelector('h2')?.textContent ||
      ''
    ).trim()
  }
  if (!data.company) {
    const companyLink = document.querySelector('[data-testid="job-metadata-block"] a[href*="/companies/"]')
    data.company = (companyLink?.textContent || '').trim()
  }
  if (!data.location) {
    const metaBlock = document.querySelector('[data-testid="job-metadata-block"]')
    if (metaBlock) {
      const locSvg = metaBlock.querySelector('svg[alt="Location"]')
      if (locSvg) {
        const parent = locSvg.closest('div[variant]') || locSvg.parentElement
        const span = parent?.querySelector('span span') || parent?.querySelector('span')
        data.location = span?.textContent?.trim() || ''
      }
    }
  }
  if (!data.description) {
    data.description = (
      document.querySelector('[data-testid="job-section-description"]')?.innerText ||
      document.querySelector('[data-testid="job-section-experience"]')?.innerText ||
      ''
    ).trim()
  }
  if (!data.company_logo) {
    const logoImg = document.querySelector('[data-testid="job-metadata-block"] figure img')
    if (logoImg?.src) data.company_logo = logoImg.src
  }

  // Extract contract type, remote, etc. from tag divs
  const metaBlock = document.querySelector('[data-testid="job-metadata-block"]')
  if (metaBlock) {
    const tags = metaBlock.querySelectorAll('div[variant="default"]')
    for (const tag of tags) {
      const svg = tag.querySelector('svg[alt]')
      const svgAlt = svg?.getAttribute('alt') || ''
      const text = tag.textContent?.trim() || ''
      if (svgAlt === 'Remote') {
        data.is_remote = text.toLowerCase().includes('full') || text.toLowerCase().includes('complet')
      }
      if (svgAlt === 'Contract' && !data.job_type) {
        const ct = text.toLowerCase()
        if (ct.includes('cdi') || ct.includes('full')) data.job_type = 'Full-time'
        else if (ct.includes('cdd')) data.job_type = 'Contract'
        else if (ct.includes('stage') || ct.includes('intern')) data.job_type = 'Internship'
        else if (ct.includes('alternance') || ct.includes('apprenti')) data.job_type = 'Apprenticeship'
        else if (ct.includes('freelance')) data.job_type = 'Freelance'
      }
    }
  }

  data.location = data.location || ''
  data.url = window.location.href.split('?')[0]
  data.source = 'welcometothejungle'
  return data
}

// ============================================================================
// Toast
// ============================================================================

function showToast(msg, link) {
  document.querySelector('.jobswiper-toast')?.remove()
  const toast = document.createElement('div')
  toast.className = 'jobswiper-toast'
  toast.textContent = msg
  if (link) {
    const a = document.createElement('a')
    a.href = link
    a.target = '_blank'
    a.textContent = 'Open in JobSwiper'
    toast.appendChild(a)
  }
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

// ============================================================================
// Save handler
// ============================================================================

async function handleSave(btn, jobDataOverride, retryCount = 0) {
  btn.innerHTML = '<div class="spinner"></div> Saving...'
  btn.disabled = true

  const jobData = jobDataOverride || extractJobData()
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
        if (result.token) return handleSave(btn, jobData, retryCount + 1)
      } catch {}
      btn.innerHTML = '🔒 Reconnect in popup'
      setTimeout(() => resetButton(btn), 3000)
      return
    }

    if (response && !response.success && retryCount < 1) {
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, jobData, retryCount + 1)
    }

    btn.innerHTML = '❌ ' + esc(response?.error || 'Failed')
    setTimeout(() => resetButton(btn), 2000)
  } catch (err) {
    if (retryCount < 1) {
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, jobData, retryCount + 1)
    }
    btn.innerHTML = '❌ ' + esc(err.message || 'Error')
    showToast('Error: ' + (err.message || 'Could not connect to JobSwiper'))
    setTimeout(() => resetButton(btn), 3000)
  }
}

// ============================================================================
// Button helpers
// ============================================================================

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `${_beamHTML}<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="16" height="16"></span> Save to JobSwiper`
}

// ============================================================================
// Detail page injection — same as LinkedIn/Indeed
// ============================================================================

let _bar = null
let _barBtn = null
let _currentSlug = ''

function getSlug() {
  const m = window.location.pathname.match(/\/companies\/[^/]+\/jobs\/([^/?]+)/)
  return m ? m[1] : ''
}

function isDetailPage() {
  return /\/companies\/[^/]+\/jobs\/[^/]+/.test(window.location.pathname)
}

function isSearchPage() {
  return window.location.pathname.match(/\/[a-z]{2}\/jobs\b/) && !isDetailPage()
}

function injectDetailButton() {
  if (_barBtn && document.body.contains(_barBtn)) return true

  // Target: the div containing "Postuler" + "Sauvegarder" buttons
  // Structure: div.cgGLml > button[apply] + button[bookmark]
  const applyBtn = document.querySelector('[data-testid="job_header-button-apply"]')
  const bookmarkBtn = document.querySelector('[data-testid="bookmark-button-company-offer"]')

  // The container div holding apply + bookmark buttons
  const btnContainer = applyBtn?.parentElement || bookmarkBtn?.parentElement
  if (!btnContainer) return false

  _barBtn = document.createElement('button')
  _barBtn.className = 'jobswiper-save-btn'
  _barBtn.style.cssText = 'padding:8px 20px 8px 16px;font-size:15px;border-radius:10px;border:1px solid #e0e0e0;white-space:nowrap;overflow:visible;'
  resetButton(_barBtn)
  _barBtn.addEventListener('click', () => handleSave(_barBtn))

  // Insert our button right after bookmark (or after apply if no bookmark)
  if (bookmarkBtn) {
    bookmarkBtn.after(_barBtn)
  } else {
    btnContainer.appendChild(_barBtn)
  }

  // Mark the container so we can find our button later
  _bar = _barBtn

  // Score badge — insert after our button (tier styling applied once data arrives)
  const scoreBadge = document.createElement('span')
  scoreBadge.className = 'jobswiper-inline-score'
  scoreBadge.style.background = '#f4f4f5'
  scoreBadge.style.color = '#71717a'
  scoreBadge.textContent = '...'
  _barBtn.after(scoreBadge)

  // Fetch score
  try {
    chrome.storage.local.get('token', ({ token }) => {
      if (!token) { scoreBadge.remove(); return }
      const jobData = extractJobData()
      fetchWithTimeout(`${API_BASE}/api/extension/analyze-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(jobData),
      }, 8000).then(r => r.json()).then(result => {
        const score = result.match_score
        if (score == null) { scoreBadge.remove(); return }
        window.JobSwiperMatch.applyMatchBadge(scoreBadge, score)
        window.JobSwiperMatch.attachExplanationPopover(scoreBadge, score, result)
        if (result.already_saved) {
          _barBtn.className = 'jobswiper-save-btn saved'
          _barBtn.innerHTML = `${_beamHTML}✓ Saved`
        }
      }).catch(() => scoreBadge.remove())
    })
  } catch { scoreBadge.remove() }

  return true
}

function updateDetail() {
  const slug = getSlug()
  if (!slug) return

  if (slug === _currentSlug && _barBtn && document.body.contains(_barBtn)) return
  _currentSlug = slug

  // Remove old button + score badge
  if (_barBtn && document.body.contains(_barBtn)) {
    const scoreBadge = _barBtn.nextElementSibling
    if (scoreBadge?.classList.contains('jobswiper-inline-score')) scoreBadge.remove()
    _barBtn.remove()
  }
  _barBtn = null
  _bar = null

  injectDetailButton()
}

// ============================================================================
// Search page injection — button on each card
// ============================================================================

function extractCardData(card) {
  const data = {}

  // Title from <h2>
  data.title = card.querySelector('h2')?.textContent?.trim() || ''
  if (!data.title) {
    const link = card.querySelector('a[aria-label]')
    const label = link?.getAttribute('aria-label') || ''
    data.title = label.replace(/^Consultez l'offre\s*/i, '').replace(/^View offer\s*/i, '').trim()
  }

  // Company from cover image alt or span near logo
  const logoImg = card.querySelector('img[data-testid^="job-thumb-logo"]')
  if (logoImg) {
    const wrapper = logoImg.closest('div')
    const span = wrapper?.parentElement?.querySelector(':scope > span')
    data.company = span?.textContent?.trim() || logoImg.alt || ''
    if (logoImg.src) data.company_logo = logoImg.src
  }
  if (!data.company) {
    const img = card.querySelector('img[alt]')
    data.company = img?.alt?.trim() || ''
  }

  // URL
  const link = card.querySelector('a[href*="/companies/"][href*="/jobs/"]')
  if (!link) return null
  const href = link.getAttribute('href')
  data.url = href.startsWith('http') ? href.split('?')[0] : 'https://www.welcometothejungle.com' + href.split('?')[0]

  // Location & other tags
  const tags = card.querySelectorAll('div[variant="default"]')
  for (const tag of tags) {
    const svg = tag.querySelector('svg[alt]')
    const alt = svg?.getAttribute('alt') || ''
    if (alt === 'Location') {
      const span = tag.querySelector('span span') || tag.querySelector('span')
      data.location = span?.textContent?.trim() || ''
    } else if (alt === 'Contract') {
      const t = tag.textContent?.toLowerCase() || ''
      if (t.includes('cdi')) data.job_type = 'Full-time'
      else if (t.includes('cdd')) data.job_type = 'Contract'
      else if (t.includes('stage')) data.job_type = 'Internship'
    } else if (alt === 'Tag') {
      data.industry = tag.textContent?.trim() || ''
    } else if (alt === 'Department') {
      data.company_size = tag.textContent?.trim() || ''
    }
  }

  data.location = data.location || ''
  data.description = ''
  data.source = 'welcometothejungle'
  return (data.title && data.company) ? data : null
}

function injectSearchButtons() {
  // Find cards — try both the li wrappers and direct card divs
  const wrappers = document.querySelectorAll('[data-testid^="search-results-list-item"]')
  const cards = wrappers.length > 0
    ? Array.from(wrappers).map(w => w.querySelector('[data-object-id]') || w)
    : Array.from(document.querySelectorAll('[data-testid^="job-thumb-"]:not([data-testid*="cover"]):not([data-testid*="logo"])'))

  for (const card of cards) {
    if (card.querySelector('.jobswiper-save-btn')) continue

    const cardData = extractCardData(card)
    if (!cardData) continue

    const btn = document.createElement('button')
    btn.className = 'jobswiper-save-btn'
    resetButton(btn)
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      handleSave(btn, cardData)
    })

    // Wrap in a bar div
    const bar = document.createElement('div')
    bar.className = 'jobswiper-wttj-card-bar'
    bar.style.cssText = 'padding:6px 12px;display:flex;align-items:center;'
    bar.appendChild(btn)

    // Insert: after the tags section, before the action buttons
    const bookmarkBtn = card.querySelector('[data-testid^="bookmark-button"]')
    const actionsRow = bookmarkBtn?.closest('div[class]')?.parentElement
    if (actionsRow) {
      actionsRow.before(bar)
    } else {
      // Fallback: append to card
      card.appendChild(bar)
    }
  }
}

// ============================================================================
// Polling
// ============================================================================

let _lastPath = ''

function poll() {
  try {
    const path = window.location.pathname
    if (path !== _lastPath) {
      _lastPath = path
      _currentSlug = ''
      if (_barBtn && document.body.contains(_barBtn)) {
        const scoreBadge = _barBtn.nextElementSibling
        if (scoreBadge?.classList.contains('jobswiper-inline-score')) scoreBadge.remove()
        _barBtn.remove()
      }
      _barBtn = null
      _bar = null
    }

    if (isDetailPage()) {
      updateDetail()
      // Re-inject if React destroyed our button
      if (!document.querySelector('.jobswiper-save-btn') && _currentSlug) {
        _barBtn = null
        _bar = null
        injectDetailButton()
      }
    } else if (isSearchPage()) {
      injectSearchButtons()
    }
  } catch {
    // Extension context invalidated
  }
}

// Boot
console.log('[JobSwiper] WTTJ script loaded:', window.location.pathname)
_lastPath = window.location.pathname

// Initial + poll
setTimeout(poll, 500)
setTimeout(poll, 2000)
setInterval(poll, 1500)
