/**
 * JobSwiper shared extraction helpers.
 * Loaded as a plain script in job-site content scripts (window.JobSwiperExtract)
 * and required in node for tests (utils/package.json pins "type":"commonjs").
 */
(function (root) {
  function isPlausibleJob(data) {
    if (!data) return false
    const title = (data.title || '').trim()
    const company = (data.company || '').trim()
    const description = (data.description || '').trim()
    return title.length > 0 && company.length > 0 && description.length > 200
  }

  const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
  // Phone-shaped only: either an international +-prefixed run, or a national number
  // that STARTS with ( or 0 and is written as 3+ groups joined by a real space/dot/dash.
  // Groups are capped at 4 digits, and every separator is mandatory, so pure digit runs
  // (reference numbers like 2026071012345) and 5+ digit groups (salaries like 60000-75000)
  // never look like a phone. Bounded quantifiers only (no catastrophic backtracking).
  const PHONE_RE =
    /(?:\+\d{1,4}(?:[\s.-]\d{1,4}){2,6})|(?:(?:\(\d{2,4}\)|0\d{0,3})(?:[\s.-]\d{2,4}){2,5})/g
  const PROFILE_URL_RE = /https?:\/\/[^\s]*linkedin\.com\/in\/[^\s]*/gi

  function stripPII(text) {
    return String(text || '')
      .replace(EMAIL_RE, '[email]')
      .replace(PROFILE_URL_RE, '[profile]')
      .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m))
  }

  function collectPageText(maxChars) {
    const max = maxChars || 15000
    const containers = [
      '.jobs-description-content__text',
      '#job-details',
      '[class*="jobs-description"]',
      'main',
      'body',
    ]
    let text = ''
    for (const sel of containers) {
      const el = typeof document !== 'undefined' ? document.querySelector(sel) : null
      if (el && el.innerText && el.innerText.trim().length > 400) {
        text = el.innerText
        break
      }
    }
    if (!text && typeof document !== 'undefined') text = (document.body && document.body.innerText) || ''
    return stripPII(text).slice(0, max)
  }

  const api = { isPlausibleJob, stripPII, collectPageText }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.JobSwiperExtract = api
})(typeof window !== 'undefined' ? window : null)
