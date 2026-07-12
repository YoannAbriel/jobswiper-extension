/**
 * JobSwiper shared capture flow (content scripts ONLY).
 * Owns the stage-3 AI extraction net so the four job-site scripts do not each
 * carry a copy of the network + merge + plausibility logic. Unlike
 * extract-helpers.js this file may use chrome.* APIs: it is never required by
 * the node test suite.
 */
(function (root) {
  if (!root) return

  // Stage 3: AI net. Returns a plausible jobData or null.
  // opts.source: the source value the DOM path of the calling site emits.
  // opts.canonicalUrl: optional function returning a canonical job URL to
  // override the AI result's url (LinkedIn /jobs/view/{id}/), or null.
  async function aiExtractFallback(opts) {
    const source = opts && opts.source
    const canonicalUrl = opts && opts.canonicalUrl
    const helpers = root.JobSwiperExtract
    const pageText = helpers.collectPageText()
    if (pageText.length < 200) return null
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'PARSE_JOB_PAGE',
        pageText,
        url: root.location.href,
      })
      if (!res?.success || !res.job) return null
      const job = { ...res.job, source, extraction_method: 'ai' }
      const canonical = typeof canonicalUrl === 'function' ? canonicalUrl() : null
      if (canonical) job.url = canonical
      else if (!job.url) job.url = root.location.href
      return helpers.isPlausibleJob(job) ? job : null
    } catch {
      return null
    }
  }

  root.JobSwiperCapture = { aiExtractFallback }
})(typeof window !== 'undefined' ? window : null)
