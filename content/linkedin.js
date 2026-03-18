/**
 * JobSwiper Content Script — LinkedIn
 */

// const API_BASE = 'https://www.jobswiper.ai' // Production
const API_BASE = 'http://localhost:3001' // Dev

function extractJobData() {
  const data = {}

  data.title = (
    document.querySelector('.job-details-jobs-unified-top-card__job-title')?.textContent ||
    document.querySelector('.jobs-unified-top-card__job-title')?.textContent ||
    document.querySelector('h1.t-24')?.textContent ||
    document.querySelector('h2.t-24')?.textContent ||
    ''
  ).trim()

  data.company = (
    document.querySelector('.job-details-jobs-unified-top-card__company-name')?.textContent ||
    document.querySelector('.jobs-unified-top-card__company-name')?.textContent ||
    document.querySelector('.topcard__org-name-link')?.textContent ||
    ''
  ).trim()

  data.location = (
    document.querySelector('.job-details-jobs-unified-top-card__bullet')?.textContent ||
    document.querySelector('.jobs-unified-top-card__bullet')?.textContent ||
    document.querySelector('.topcard__flavor--bullet')?.textContent ||
    ''
  ).trim()

  data.description = (
    document.querySelector('.jobs-description-content__text')?.innerText ||
    document.querySelector('.jobs-box__html-content')?.innerText ||
    document.querySelector('#job-details')?.innerText ||
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

async function handleSave(btn) {
  btn.innerHTML = '<div class="spinner"></div> Saving...'
  btn.disabled = true

  const jobData = extractJobData()
  if (!jobData.title || !jobData.company) {
    btn.innerHTML = '⚠️ Could not extract job'
    setTimeout(() => resetButton(btn), 2000)
    return
  }

  try {
    const { token } = await chrome.storage.local.get('token')
    if (!token) {
      btn.innerHTML = '🔒 Log in first'
      showToast('Log in to JobSwiper first', API_BASE + '/login')
      setTimeout(() => resetButton(btn), 2000)
      return
    }

    const response = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', data: jobData, token })

    if (response.success) {
      btn.className = 'jobswiper-save-btn saved'
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.285 2l-11.285 11.567-5.286-5.011-3.714 3.716 9 8.728 15-15.285z"/></svg> Saved!`
      showToast('✅ Job saved!', API_BASE + '/dashboard/jobs')
    } else {
      btn.innerHTML = '❌ ' + (response.error || 'Failed')
      setTimeout(() => resetButton(btn), 2000)
    }
  } catch (err) {
    btn.innerHTML = '❌ Error'
    setTimeout(() => resetButton(btn), 2000)
  }
}

function resetButton(btn) {
  btn.className = 'jobswiper-save-btn'
  btn.disabled = false
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save to JobSwiper`
}

function injectButton() {
  if (document.querySelector('.jobswiper-save-btn')) return

  const isJobDetail = window.location.pathname.includes('/jobs/view') ||
    document.querySelector('.jobs-description-content__text') ||
    document.querySelector('#job-details')

  if (!isJobDetail) return

  const btn = createSaveButton()
  btn.addEventListener('click', () => handleSave(btn))

  const actionBar = document.querySelector('.jobs-apply-button--top-card') ||
    document.querySelector('.jobs-unified-top-card__content--two-pane') ||
    document.querySelector('.job-details-jobs-unified-top-card__container')

  if (actionBar) {
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'margin: 8px 0; display: flex;'
    wrapper.appendChild(btn)
    actionBar.appendChild(wrapper)
  } else {
    btn.style.cssText = 'position: fixed; bottom: 24px; right: 24px; z-index: 99999;'
    document.body.appendChild(btn)
  }
}

injectButton()
const observer = new MutationObserver(() => {
  if (!document.querySelector('.jobswiper-save-btn')) injectButton()
})
observer.observe(document.body, { childList: true, subtree: true })
