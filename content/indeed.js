/**
 * JobSwiper Content Script — Indeed
 *
 * Injects a "Save to JobSwiper" button on Indeed job detail pages.
 * Extracts job data from the page DOM and sends to the background script.
 */

const API_BASE = 'https://www.jobswiper.ai' // Production
// const API_BASE = 'http://localhost:3001' // Dev

// ============================================================================
// Job data extraction
// ============================================================================

function extractJobData() {
  const data = {}

  // Title
  data.title = (
    document.querySelector('h1.jobsearch-JobInfoHeader-title')?.textContent ||
    document.querySelector('h2.jobTitle span')?.textContent ||
    document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent ||
    document.querySelector('h1')?.textContent ||
    ''
  ).trim()

  // Company
  data.company = (
    document.querySelector('[data-company-name]')?.textContent ||
    document.querySelector('[data-testid="inlineHeader-companyName"]')?.textContent ||
    document.querySelector('.jobsearch-InlineCompanyRating a')?.textContent ||
    document.querySelector('.companyName')?.textContent ||
    ''
  ).trim()

  // Location
  data.location = (
    document.querySelector('[data-testid="job-location"]')?.textContent ||
    document.querySelector('[data-testid="inlineHeader-companyLocation"]')?.textContent ||
    document.querySelector('.jobsearch-JobInfoHeader-subtitle .css-6z8o9s')?.textContent ||
    document.querySelector('.companyLocation')?.textContent ||
    ''
  ).trim()

  // Description
  data.description = (
    document.querySelector('#jobDescriptionText')?.innerHTML ||
    document.querySelector('.jobsearch-JobComponent-description')?.innerHTML ||
    ''
  ).trim()

  // Salary
  data.salary_range = (
    document.querySelector('#salaryInfoAndJobType .css-k5flys span')?.textContent ||
    document.querySelector('[data-testid="attribute_snippet_testid"]')?.textContent ||
    ''
  ).trim() || undefined

  // Job type from metadata
  const metaTags = document.querySelectorAll('.jobsearch-JobMetadataHeader-item')
  for (const tag of metaTags) {
    const text = tag.textContent?.trim().toLowerCase() || ''
    if (text.includes('full') || text.includes('plein') || text.includes('vollzeit')) {
      data.job_type = 'Full-time'
    } else if (text.includes('part') || text.includes('partiel') || text.includes('teilzeit')) {
      data.job_type = 'Part-time'
    } else if (text.includes('contract') || text.includes('cdd') || text.includes('befristet')) {
      data.job_type = 'Contract'
    } else if (text.includes('intern') || text.includes('stage') || text.includes('praktikum')) {
      data.job_type = 'Internship'
    }
  }

  // Remote
  data.is_remote = !!(
    document.querySelector('[data-testid="jobsearch-WorkFromHome"]') ||
    data.location?.toLowerCase().includes('remote') ||
    data.location?.toLowerCase().includes('télétravail')
  )

  // URL
  data.url = window.location.href.split('#')[0].split('?')[0]
  // Keep jk param if present
  const jk = new URLSearchParams(window.location.search).get('jk')
  if (jk) data.url += '?jk=' + jk

  // Company logo
  const logoImg = document.querySelector('.jobsearch-CompanyAvatar-image') ||
    document.querySelector('img[class*="company"]')
  if (logoImg?.src && !logoImg.src.includes('placeholder')) {
    data.company_logo = logoImg.src
  }

  data.source = 'indeed'

  return data
}

// ============================================================================
// UI: Save button injection
// ============================================================================

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

function showToast(message, link) {
  const existing = document.querySelector('.jobswiper-toast')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.className = 'jobswiper-toast'
  toast.innerHTML = message
  if (link) {
    toast.innerHTML += `<a href="${link}" target="_blank">Open in JobSwiper</a>`
  }
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

async function handleSave(btn) {
  // Show loading
  btn.innerHTML = '<div class="spinner"></div> Saving...'
  btn.disabled = true

  const jobData = extractJobData()

  if (!jobData.title || !jobData.company) {
    btn.innerHTML = '⚠️ Could not extract job data'
    setTimeout(() => resetButton(btn), 2000)
    return
  }

  try {
    // Get auth token from storage
    const { token } = await chrome.storage.local.get('token')

    if (!token) {
      btn.innerHTML = '🔒 Log in first'
      showToast('Please log in to JobSwiper first', API_BASE + '/login')
      setTimeout(() => resetButton(btn), 2000)
      return
    }

    // Send to API via background script
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_JOB',
      data: jobData,
      token,
    })

    if (response.success) {
      btn.className = 'jobswiper-save-btn saved'
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M20.285 2l-11.285 11.567-5.286-5.011-3.714 3.716 9 8.728 15-15.285z"/>
        </svg>
        Saved!
      `
      const dashboardUrl = API_BASE + '/dashboard/jobs'
      showToast('✅ Job saved to JobSwiper!', dashboardUrl)
    } else {
      btn.innerHTML = '❌ ' + (response.error || 'Save failed')
      setTimeout(() => resetButton(btn), 2000)
    }
  } catch (err) {
    console.error('[JobSwiper] Save error:', err)
    btn.innerHTML = '❌ Error'
    setTimeout(() => resetButton(btn), 2000)
  }
}

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
    </svg>
    Save to JobSwiper
  `
}

// ============================================================================
// Injection logic
// ============================================================================

function injectButton() {
  // Don't inject twice
  if (document.querySelector('.jobswiper-save-btn')) return

  // Only inject on job detail pages (not search results list)
  const isJobDetail = window.location.pathname.includes('/viewjob') ||
    document.querySelector('#jobDescriptionText') ||
    document.querySelector('.jobsearch-JobComponent-description')

  if (!isJobDetail) return

  const btn = createSaveButton()
  btn.addEventListener('click', () => handleSave(btn))

  // Find the best place to inject
  const actionBar = document.querySelector('.jobsearch-JobInfoHeader-title-container') ||
    document.querySelector('#jobsearch-ViewjobPaneWrapper') ||
    document.querySelector('#job_header') ||
    document.querySelector('h1')?.parentElement

  if (actionBar) {
    // Insert after the title area
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'margin: 12px 0; display: flex;'
    wrapper.appendChild(btn)
    actionBar.after(wrapper)
  } else {
    // Fallback: fixed position button
    btn.style.cssText = 'position: fixed; bottom: 24px; right: 24px; z-index: 99999;'
    document.body.appendChild(btn)
  }
}

// Run on page load and on SPA navigation (Indeed uses client-side routing)
injectButton()

// Watch for SPA navigation
const observer = new MutationObserver(() => {
  if (!document.querySelector('.jobswiper-save-btn')) {
    injectButton()
  }
})
observer.observe(document.body, { childList: true, subtree: true })
