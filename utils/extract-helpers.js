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
  const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g
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
