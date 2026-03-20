/**
 * JobSwiper Content Script — Indeed
 *
 * Injects:
 * 1. "Save to JobSwiper" button on job detail pages
 * 2. Analysis overlay panel (match score, skills, summary)
 * 3. Match badges on search results list
 */

// const API_BASE = 'https://www.jobswiper.ai' // Production
const API_BASE = 'http://localhost:3000' // Dev




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

// ============================================================================
// Job data extraction
// ============================================================================

function extractJobData() {
  const data = {}

  data.title = (
    document.querySelector('h1.jobsearch-JobInfoHeader-title')?.textContent ||
    document.querySelector('h2.jobTitle span')?.textContent ||
    document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent ||
    document.querySelector('h1')?.textContent || ''
  ).trim()

  data.company = (
    document.querySelector('[data-company-name]')?.textContent ||
    document.querySelector('[data-testid="inlineHeader-companyName"]')?.textContent ||
    document.querySelector('.jobsearch-InlineCompanyRating a')?.textContent ||
    document.querySelector('.companyName')?.textContent || ''
  ).trim()

  data.location = (
    document.querySelector('[data-testid="job-location"]')?.textContent ||
    document.querySelector('[data-testid="inlineHeader-companyLocation"]')?.textContent ||
    document.querySelector('.companyLocation')?.textContent || ''
  ).trim()

  // Use innerText (preserves line breaks) not innerHTML (raw HTML tags)
  data.description = (
    document.querySelector('#jobDescriptionText')?.innerText ||
    document.querySelector('.jobsearch-JobComponent-description')?.innerText || ''
  ).trim()

  // Salary — only capture if it contains currency symbols or numbers with k/K
  const rawSalary = (
    document.querySelector('#salaryInfoAndJobType .css-k5flys span')?.textContent ||
    document.querySelector('[data-testid="attribute_snippet_testid"]')?.textContent || ''
  ).trim()
  if (rawSalary && rawSalary.match(/[\d.,]+\s*[€$£]|[€$£]\s*[\d.,]+|[\d.,]+\s*[kK]\s*[-–]|[\d.,]+\s*(?:par\s|\/)\s*(?:an|mois|heure|hour|year|month)/i)) {
    data.salary_range = rawSalary
  }

  const metaTags = document.querySelectorAll('.jobsearch-JobMetadataHeader-item')
  for (const tag of metaTags) {
    const text = tag.textContent?.trim().toLowerCase() || ''
    if (text.includes('full') || text.includes('plein')) data.job_type = 'Full-time'
    else if (text.includes('part') || text.includes('partiel')) data.job_type = 'Part-time'
    else if (text.includes('contract') || text.includes('cdd')) data.job_type = 'Contract'
    else if (text.includes('intern') || text.includes('stage')) data.job_type = 'Internship'
  }

  data.is_remote = !!(
    document.querySelector('[data-testid="jobsearch-WorkFromHome"]') ||
    data.location?.toLowerCase().includes('remote') ||
    data.location?.toLowerCase().includes('télétravail')
  )

  // Build canonical job URL: always use /viewjob?jk=xxx format
  // On /viewjob pages the param is "jk", on search results (split view) it's "vjk"
  const params = new URLSearchParams(window.location.search)
  const jk = params.get('jk') || params.get('vjk')
  if (jk) {
    const origin = window.location.origin
    data.url = `${origin}/viewjob?jk=${jk}`
  } else {
    // No job key found — build a unique URL from title+company to avoid dedup collisions
    const slug = (data.title + '-' + data.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 80)
    data.url = `${window.location.origin}/extension-import/${slug}-${Date.now()}`
  }

  const logoImg = document.querySelector('.jobsearch-CompanyAvatar-image') ||
    document.querySelector('img[class*="company"]')
  if (logoImg?.src && !logoImg.src.includes('placeholder')) data.company_logo = logoImg.src

  // Posted date — Indeed shows "Posted X days ago" or "Publiée il y a X jours"
  const dateEl = document.querySelector('[data-testid="myJobsStateDate"]') ||
    document.querySelector('.jobsearch-HiringInsights-entry--bullet')
  if (dateEl) {
    const dt = dateEl.textContent?.trim() || ''
    if (dt.includes('ago') || dt.includes('il y a') || dt.includes('jour') || dt.includes('day')) {
      data.posted_date = dt
    }
  }

  data.source = 'indeed'
  return data
}

// ============================================================================
// Save button
// ============================================================================

const _logoUrl = 'data:image/png;base64,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'

const _beamHTML = '<div class="jobswiper-beam"><div></div></div>'

function createSaveButton() {
  const btn = document.createElement('button')
  btn.className = 'jobswiper-save-btn'
  btn.innerHTML = `${_beamHTML}${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="14" height="14"></span> ` : ''}Save to JobSwiper`
  return btn
}

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

async function handleSave(btn, retryCount = 0) {
  btn.innerHTML = '<div class="spinner"></div> Saving...'
  btn.disabled = true

  const jobData = extractJobData()
  if (!jobData.title || !jobData.company) {
    btn.textContent = '⚠️ Could not extract job data'
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
      btn.textContent = '🔒 Log in first'
      showToast('Please log in to JobSwiper first', API_BASE + '/login')
      setTimeout(() => resetButton(btn), 2000)
      return
    }

    // Use background worker for cross-origin requests (Manifest V3 requirement)
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', data: jobData, token })

    if (response && response.success) {
      btn.className = 'jobswiper-save-btn saved'
      btn.innerHTML = `${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="14" height="14"></span> ` : ''}Saved!`
      const jobDetailUrl = response.jobId ? `${API_BASE}/dashboard/jobs/${response.jobId}` : `${API_BASE}/dashboard/jobs`
      showToast('Job saved to JobSwiper!', jobDetailUrl)
      return
    }

    if (response && response.error && response.error.includes('Authentication') && retryCount < 2) {
      // Token expired — try to get a fresh one and retry
      await chrome.storage.local.remove('token')
      try {
        await chrome.runtime.sendMessage({ type: 'AUTO_CONNECT' })
        const result = await chrome.storage.local.get('token')
        if (result.token) {
          // Retry with fresh token
          return handleSave(btn, retryCount + 1)
        }
      } catch {}
      btn.textContent = '🔒 Reconnect in popup'
      setTimeout(() => resetButton(btn), 3000)
      return
    }

    // Other error — retry once
    if (response && !response.success && retryCount < 1) {
      console.log('[JobSwiper] Save failed, retrying...', response?.error)
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }

    btn.textContent = '❌ ' + (response?.error || 'Save failed')
    setTimeout(() => resetButton(btn), 2000)
  } catch (err) {
    // Network error — retry once
    if (retryCount < 1) {
      console.log('[JobSwiper] Network error, retrying...', err.message)
      await new Promise(r => setTimeout(r, 1000))
      return handleSave(btn, retryCount + 1)
    }
    console.error('[JobSwiper] Save error:', err)
    btn.textContent = '❌ ' + (err.message || 'Connection error')
    showToast('Error: ' + (err.message || 'Could not connect to JobSwiper'))
    setTimeout(() => resetButton(btn), 3000)
  }
}

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `${_beamHTML}${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="14" height="14"></span> ` : ''}Save to JobSwiper`
}

// ============================================================================
// Analysis overlay panel
// ============================================================================

async function showAnalysisPanel() {
  // Remove existing panel
  document.querySelector('.jobswiper-panel')?.remove()

  const { token } = await chrome.storage.local.get('token')
  if (!token) return

  const jobData = extractJobData()
  if (!jobData.title) return

  // Create panel
  const panel = document.createElement('div')
  panel.className = 'jobswiper-panel'
  panel.innerHTML = `
    <div class="jobswiper-panel-header">
      <h3>JobSwiper Analysis</h3>
      <button class="jobswiper-panel-close">×</button>
    </div>
    <div class="jobswiper-panel-body">
      <div class="jobswiper-loading">
        <div class="spinner"></div>
        Analyzing job...
      </div>
    </div>
  `

  panel.querySelector('.jobswiper-panel-close').addEventListener('click', () => panel.remove())
  document.body.appendChild(panel)

  // Call analyze API
  try {
    const response = await fetchWithTimeout(`${API_BASE}/api/extension/analyze-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(jobData),
    }, 10000)

    if (!response.ok) throw new Error('API error ' + response.status)
    const data = await response.json()

    // Render results
    const body = panel.querySelector('.jobswiper-panel-body')
    body.innerHTML = ''

    // Already saved badge
    if (data.already_saved) {
      body.innerHTML += `<div class="jobswiper-already-saved">✓ Already saved to your pipeline</div>`
    }

    // Match score
    const level = data.match_score >= 80 ? 'strong' : data.match_score >= 60 ? 'good' : 'low'
    body.innerHTML += `
      <div class="jobswiper-score ${level}">
        <div>
          <div class="jobswiper-score-num">${data.match_score}%</div>
        </div>
        <div>
          <div class="jobswiper-score-label">${data.match_level} match</div>
          <div style="font-size:11px;color:#71717a;margin-top:2px">${data.matched_skills?.length || 0}/${data.keywords?.length || 0} skills matched</div>
        </div>
      </div>
    `

    // Matched skills
    if (data.matched_skills?.length > 0) {
      body.innerHTML += `
        <div class="jobswiper-section">
          <div class="jobswiper-section-title">✓ Your matching skills</div>
          <div class="jobswiper-skills">
            ${data.matched_skills.map(s => `<span class="jobswiper-skill matched">${esc(s)}</span>`).join('')}
          </div>
        </div>
      `
    }

    // Missing skills
    if (data.missing_skills?.length > 0) {
      body.innerHTML += `
        <div class="jobswiper-section">
          <div class="jobswiper-section-title">⚠ Skills to highlight</div>
          <div class="jobswiper-skills">
            ${data.missing_skills.map(s => `<span class="jobswiper-skill missing">${esc(s)}</span>`).join('')}
          </div>
        </div>
      `
    }

    // Summary
    if (data.summary) {
      body.innerHTML += `<div class="jobswiper-summary">${esc(data.summary)}</div>`
    }

    // Notes + rating section
    body.innerHTML += `
      <div class="jobswiper-section">
        <div class="jobswiper-section-title">Your notes</div>
        <div style="display:flex;gap:2px;margin-bottom:6px" class="jobswiper-stars">
          ${[1,2,3,4,5].map(n => `<button data-star="${n}" style="background:none;border:none;cursor:pointer;font-size:18px;padding:0;color:#d1d5db">☆</button>`).join('')}
        </div>
        <textarea class="jobswiper-notes" placeholder="Add a note about this job..." style="width:100%;min-height:48px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;font-family:inherit;resize:vertical;outline:none;"></textarea>
      </div>
    `

    // Star rating logic
    let selectedRating = 0
    const stars = body.querySelectorAll('.jobswiper-stars button')
    stars.forEach(star => {
      star.addEventListener('click', () => {
        selectedRating = parseInt(star.dataset.star)
        stars.forEach((s, i) => {
          s.textContent = i < selectedRating ? '★' : '☆'
          s.style.color = i < selectedRating ? '#f59e0b' : '#d1d5db'
        })
      })
      star.addEventListener('mouseenter', () => {
        const val = parseInt(star.dataset.star)
        stars.forEach((s, i) => {
          s.style.color = i < val ? '#f59e0b' : '#d1d5db'
        })
      })
      star.addEventListener('mouseleave', () => {
        stars.forEach((s, i) => {
          s.style.color = i < selectedRating ? '#f59e0b' : '#d1d5db'
        })
      })
    })

    // Profile tip (use DOM methods to avoid destroying star event listeners)
    if (data.profile_skills_count === 0) {
      const tip = document.createElement('div')
      tip.style.cssText = 'font-size:11px;color:#71717a;text-align:center;padding:8px;background:#f4f4f5;border-radius:8px'
      tip.innerHTML = `💡 Add skills to your <a href="${API_BASE}/dashboard/profile" target="_blank" style="color:#1e3a5f;font-weight:600">profile</a> for better match scores`
      body.appendChild(tip)
    }

  } catch (err) {
    console.error('[JobSwiper] Analysis error:', err)
    panel.querySelector('.jobswiper-panel-body').innerHTML = `
      <div style="text-align:center;padding:16px;color:#71717a;font-size:12px">
        Could not analyze this job.<br>
        <span style="font-size:11px">${err.message}</span>
      </div>
    `
  }
}

// ============================================================================
// Injection logic
// ============================================================================

function injectButton() {
  if (document.querySelector('.jobswiper-save-btn')) return

  const isJobDetail = window.location.pathname.includes('/viewjob') ||
    document.querySelector('#jobDescriptionText') ||
    document.querySelector('.jobsearch-JobComponent-description')

  if (!isJobDetail) return

  const btn = createSaveButton()
  btn.addEventListener('click', () => handleSave(btn))

  const actionBar = document.querySelector('.jobsearch-JobInfoHeader-title-container') ||
    document.querySelector('#jobsearch-ViewjobPaneWrapper') ||
    document.querySelector('#job_header') ||
    document.querySelector('h1')?.parentElement

  // Score badge next to button
  const scoreBadge = document.createElement('span')
  scoreBadge.className = 'jobswiper-inline-score'
  scoreBadge.style.cssText = 'display:inline-flex;align-items:center;padding:5px 10px;border-radius:8px;font-size:12px;font-weight:700;background:#f4f4f5;color:#71717a;font-family:-apple-system,BlinkMacSystemFont,sans-serif;'
  scoreBadge.textContent = '...'

  if (actionBar) {
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'margin: 12px 0; display: flex; gap: 8px; align-items: center;'
    wrapper.appendChild(btn)
    wrapper.appendChild(scoreBadge)
    actionBar.after(wrapper)
  } else {
    btn.style.cssText += 'position: fixed; bottom: 24px; right: 24px; z-index: 99999;'
    document.body.appendChild(btn)
    scoreBadge.style.cssText += 'position:fixed;bottom:24px;right:220px;z-index:99999;'
    document.body.appendChild(scoreBadge)
  }

  // Fetch score for inline badge
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

      scoreBadge.textContent = score + '% match'
      if (score >= 80) { scoreBadge.style.background = '#d1fae5'; scoreBadge.style.color = '#065f46' }
      else if (score >= 60) { scoreBadge.style.background = '#fef3c7'; scoreBadge.style.color = '#92400e' }
      else { scoreBadge.style.background = '#f4f4f5'; scoreBadge.style.color = '#71717a' }

      if (data.already_saved) {
        btn.className = 'jobswiper-save-btn saved'
        btn.innerHTML = `${_logoUrl ? `<span class="jobswiper-logo-wrap"><img src="${_logoUrl}" width="14" height="14"></span> ` : ''}Saved`
      }
    }).catch(() => scoreBadge.remove())
  })

  // Don't auto-show analysis panel — score is inline next to the button
}

// ============================================================================
// Search results: inject mini badges on each job card
// ============================================================================

let badgeDebounce = null
let badgesProcessing = false

async function injectSearchBadges() {
  // Debounce — only run once per 2 seconds
  if (badgeDebounce) clearTimeout(badgeDebounce)
  badgeDebounce = setTimeout(_doInjectBadges, 2000)
}

async function _doInjectBadges() {
  if (badgesProcessing) return
  if (window.location.pathname.includes('/viewjob')) return

  const { token } = await chrome.storage.local.get('token')
  if (!token) return

  const cards = document.querySelectorAll('.job_seen_beacon, .resultContent, [data-jk]')
  if (cards.length === 0) return

  // Collect cards that need badges — extract title + company + snippet
  const pending = []
  for (const card of cards) {
    if (card.querySelector('.jobswiper-badge')) continue
    const title = (card.querySelector('h2.jobTitle span') || card.querySelector('h2 a span'))?.textContent?.trim()
    if (!title) continue
    const titleEl = card.querySelector('h2.jobTitle') || card.querySelector('h2')
    if (!titleEl) continue

    const company = (card.querySelector('[data-testid="company-name"]') || card.querySelector('.companyName') || card.querySelector('.company_location .companyName'))?.textContent?.trim() || ''
    const location = (card.querySelector('[data-testid="text-location"]') || card.querySelector('.companyLocation'))?.textContent?.trim() || ''
    const snippet = (card.querySelector('.job-snippet') || card.querySelector('[class*="job-snippet"]') || card.querySelector('table.jobCardShelfContainer'))?.textContent?.trim() || ''

    const badge = document.createElement('span')
    badge.className = 'jobswiper-badge'
    badge.textContent = '...'
    titleEl.appendChild(badge)
    pending.push({ title, company, location, snippet, badge })
  }

  if (pending.length === 0) return
  badgesProcessing = true

  // Process max 5 at a time to avoid flooding
  for (let i = 0; i < pending.length; i += 5) {
    const batch = pending.slice(i, i + 5)
    await Promise.all(batch.map(async ({ title, company, location, snippet, badge }) => {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/api/extension/analyze-job`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ title, company, location, description: snippet, url: '' }),
        }, 8000)
        if (res.ok) {
          const data = await res.json()
          const score = data.match_score
          if (score == null) { badge.remove(); return }
          if (score >= 80) { badge.style.background = '#d1fae5'; badge.style.color = '#065f46' }
          else if (score >= 60) { badge.style.background = '#fef3c7'; badge.style.color = '#92400e' }
          badge.textContent = score + '%'
          if (data.already_saved) {
            badge.textContent = '✓ ' + score + '%'
            badge.style.background = '#dbeafe'; badge.style.color = '#1e40af'
          }
        }
      } catch { badge.remove() }
    }))
  }

  badgesProcessing = false
}

// Track which job we've injected for
let injectedForTitle = ''

function getCurrentJobTitle() {
  return (
    document.querySelector('h1.jobsearch-JobInfoHeader-title')?.textContent ||
    document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent ||
    document.querySelector('h2.jobTitle span')?.textContent || ''
  ).trim()
}

function clearInjected() {
  document.querySelector('.jobswiper-save-btn')?.closest('div')?.remove()
  document.querySelector('.jobswiper-panel')?.remove()
  document.querySelectorAll('.jobswiper-inline-score').forEach(el => el.remove())
  injectedForTitle = ''
}

// Run on page load
injectButton()
injectSearchBadges()
injectedForTitle = getCurrentJobTitle()

// Poll every 500ms to detect job changes (more reliable than MutationObserver for Indeed's SPA)
setInterval(() => {
  try {
    const currentTitle = getCurrentJobTitle()

    if (currentTitle && currentTitle !== injectedForTitle) {
      clearInjected()
      setTimeout(() => {
        injectButton()
        injectedForTitle = getCurrentJobTitle()
      }, 200)
    }

    // Re-inject if button was removed by Indeed's DOM updates
    if (currentTitle && !document.querySelector('.jobswiper-save-btn')) {
      injectButton()
      injectedForTitle = getCurrentJobTitle()
    }

    injectSearchBadges()
  } catch {
    // Extension context invalidated — stop polling
  }
}, 500)
