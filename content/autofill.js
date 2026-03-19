/**
 * JobSwiper — Auto-fill for job application forms
 *
 * Detects common application platforms (Workday, Greenhouse, Lever, etc.)
 * and fills in basic profile fields from stored user data.
 */

// const API_BASE = 'https://www.jobswiper.ai'
// const API_BASE = 'https://www.jobswiper.ai' // Production
const API_BASE = 'http://localhost:3000' // Dev

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
}

// Field mappings: common label patterns → profile field
const FIELD_MAP = [
  { patterns: ['first name', 'prénom', 'vorname', 'nombre'], field: 'first_name' },
  { patterns: ['last name', 'nom de famille', 'nachname', 'apellido', 'family name', 'surname'], field: 'last_name' },
  { patterns: ['full name', 'nom complet', 'your name'], field: 'full_name' },
  { patterns: ['email', 'e-mail', 'courriel'], field: 'email' },
  { patterns: ['phone', 'téléphone', 'telefon', 'mobile', 'cell'], field: 'phone' },
  { patterns: ['linkedin'], field: 'linkedin_url' },
  { patterns: ['city', 'ville', 'stadt', 'ciudad', 'location'], field: 'city' },
  { patterns: ['address', 'adresse', 'street'], field: 'address' },
  { patterns: ['portfolio', 'website', 'site web', 'personal site'], field: 'website' },
]

let profileData = null

async function loadProfile() {
  if (profileData) return profileData

  const { token } = await chrome.storage.local.get('token')
  if (!token) return null

  // Try to get from cache first
  const { cachedProfile } = await chrome.storage.local.get('cachedProfile')
  if (cachedProfile && Date.now() - cachedProfile.ts < 1000 * 60 * 30) {
    profileData = cachedProfile.data
    return profileData
  }

  // Fetch from API (reuse stats endpoint which has profile data)
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/extension/stats`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }, 8000)
    if (res.status === 401) {
      chrome.storage.local.remove('token')
      return null
    }
    if (!res.ok) return null
    const stats = await res.json()

    // We need more profile fields — for now use what we have
    // TODO: add a dedicated profile endpoint
    profileData = stats._profile || null

    return profileData
  } catch {
    return null
  }
}

function findMatchingField(input) {
  // Get the label text for this input
  const label = (
    input.getAttribute('aria-label') ||
    input.getAttribute('placeholder') ||
    input.getAttribute('name') ||
    document.querySelector(`label[for="${input.id}"]`)?.textContent ||
    input.closest('label')?.textContent ||
    input.closest('[class*="field"]')?.querySelector('label')?.textContent ||
    ''
  ).toLowerCase().trim()

  if (!label) return null

  for (const mapping of FIELD_MAP) {
    if (mapping.patterns.some(p => label.includes(p))) {
      return mapping.field
    }
  }
  return null
}

function fillField(input, value) {
  if (!value || input.value) return // Don't overwrite existing values

  // Set value and dispatch events (for React/Angular forms)
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  nativeInputValueSetter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.dispatchEvent(new Event('blur', { bubbles: true }))

  // Visual feedback
  input.style.outline = '2px solid #1e3a5f'
  input.style.outlineOffset = '1px'
  setTimeout(() => {
    input.style.outline = ''
    input.style.outlineOffset = ''
  }, 2000)
}

async function tryAutofill() {
  const { token } = await chrome.storage.local.get('token')
  if (!token) return

  // Get stored profile from extension storage
  const { userProfile } = await chrome.storage.local.get('userProfile')
  if (!userProfile) return

  const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])')

  let filledCount = 0
  for (const input of inputs) {
    const field = findMatchingField(input)
    if (!field) continue

    const value = userProfile[field]
    if (value && !input.value) {
      fillField(input, value)
      filledCount++
    }
  }

  if (filledCount > 0) {
    // Show toast
    const toast = document.createElement('div')
    toast.className = 'jobswiper-toast'
    toast.textContent = `✅ Auto-filled ${filledCount} fields`
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  }
}

// Inject auto-fill button on application pages
function injectAutofillButton() {
  if (document.querySelector('.jobswiper-autofill-btn')) return

  // Detect if this is an application form
  const isApplicationForm =
    document.querySelector('form[class*="application"]') ||
    document.querySelector('[class*="apply"]') ||
    document.querySelector('input[name*="resume"]') ||
    document.querySelector('input[type="file"]') ||
    window.location.hostname.includes('greenhouse') ||
    window.location.hostname.includes('lever') ||
    window.location.hostname.includes('workday') ||
    window.location.hostname.includes('icims') ||
    window.location.hostname.includes('smartrecruiters')

  if (!isApplicationForm) return

  const btn = document.createElement('button')
  btn.className = 'jobswiper-save-btn jobswiper-autofill-btn'
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Auto-fill with JobSwiper`
  btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;'
  btn.addEventListener('click', () => tryAutofill())
  document.body.appendChild(btn)
}

// Run
setTimeout(injectAutofillButton, 2000)
