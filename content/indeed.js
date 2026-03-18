/**
 * JobSwiper Content Script — Indeed
 *
 * Injects:
 * 1. "Save to JobSwiper" button on job detail pages
 * 2. Analysis overlay panel (match score, skills, summary)
 * 3. Match badges on search results list
 */

// const API_BASE = 'https://www.jobswiper.ai' // Production
const API_BASE = 'http://localhost:3001' // Dev

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

  data.description = (
    document.querySelector('#jobDescriptionText')?.innerHTML ||
    document.querySelector('.jobsearch-JobComponent-description')?.innerHTML || ''
  ).trim()

  data.salary_range = (
    document.querySelector('#salaryInfoAndJobType .css-k5flys span')?.textContent ||
    document.querySelector('[data-testid="attribute_snippet_testid"]')?.textContent || ''
  ).trim() || undefined

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

  data.url = window.location.href.split('#')[0].split('?')[0]
  const jk = new URLSearchParams(window.location.search).get('jk')
  if (jk) data.url += '?jk=' + jk

  const logoImg = document.querySelector('.jobsearch-CompanyAvatar-image') ||
    document.querySelector('img[class*="company"]')
  if (logoImg?.src && !logoImg.src.includes('placeholder')) data.company_logo = logoImg.src

  data.source = 'indeed'
  return data
}

// ============================================================================
// Save button
// ============================================================================

function createSaveButton() {
  const btn = document.createElement('button')
  btn.className = 'jobswiper-save-btn'
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save to JobSwiper`
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

async function handleSave(btn) {
  btn.innerHTML = '<div class="spinner"></div> Saving...'
  btn.disabled = true

  const jobData = extractJobData()
  if (!jobData.title || !jobData.company) {
    btn.textContent = '⚠️ Could not extract job data'
    setTimeout(() => resetButton(btn), 2000)
    return
  }

  try {
    const { token } = await chrome.storage.local.get('token')
    if (!token) {
      btn.textContent = '🔒 Log in first'
      showToast('Please log in to JobSwiper first', API_BASE + '/login')
      setTimeout(() => resetButton(btn), 2000)
      return
    }

    const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', data: jobData, token })

    if (response.success) {
      btn.className = 'jobswiper-save-btn saved'
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.285 2l-11.285 11.567-5.286-5.011-3.714 3.716 9 8.728 15-15.285z"/></svg> Saved!`
      showToast('✅ Job saved to JobSwiper!', API_BASE + '/dashboard/jobs')

      // Update overlay if present
      const badge = document.querySelector('.jobswiper-already-saved')
      if (!badge) {
        const panel = document.querySelector('.jobswiper-panel-body')
        if (panel) {
          const saved = document.createElement('div')
          saved.className = 'jobswiper-already-saved'
          saved.textContent = '✓ Saved to your pipeline'
          panel.prepend(saved)
        }
      }
    } else {
      btn.textContent = '❌ ' + (response.error || 'Save failed')
      setTimeout(() => resetButton(btn), 2000)
    }
  } catch (err) {
    console.error('[JobSwiper] Save error:', err)
    btn.textContent = '❌ Error'
    setTimeout(() => resetButton(btn), 2000)
  }
}

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save to JobSwiper`
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
    const response = await fetch(`${API_BASE}/api/extension/analyze-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(jobData),
    })

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
            ${data.matched_skills.map(s => `<span class="jobswiper-skill matched">${s}</span>`).join('')}
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
            ${data.missing_skills.map(s => `<span class="jobswiper-skill missing">${s}</span>`).join('')}
          </div>
        </div>
      `
    }

    // Summary
    if (data.summary) {
      body.innerHTML += `<div class="jobswiper-summary">${data.summary}</div>`
    }

    // Profile tip
    if (data.profile_skills_count === 0) {
      body.innerHTML += `
        <div style="font-size:11px;color:#71717a;text-align:center;padding:8px;background:#f4f4f5;border-radius:8px">
          💡 Add skills to your <a href="${API_BASE}/dashboard/profile" target="_blank" style="color:#1e3a5f;font-weight:600">profile</a> for better match scores
        </div>
      `
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

  if (actionBar) {
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'margin: 12px 0; display: flex; gap: 8px; align-items: center;'
    wrapper.appendChild(btn)
    actionBar.after(wrapper)
  } else {
    btn.style.cssText = 'position: fixed; bottom: 24px; right: 24px; z-index: 99999;'
    document.body.appendChild(btn)
  }

  // Auto-show analysis panel
  showAnalysisPanel()
}

// Run on page load + SPA navigation
injectButton()
const observer = new MutationObserver(() => {
  if (!document.querySelector('.jobswiper-save-btn')) injectButton()
})
observer.observe(document.body, { childList: true, subtree: true })
