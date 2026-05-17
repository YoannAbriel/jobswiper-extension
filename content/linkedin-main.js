/**
 * LinkedIn MAIN-world bridge.
 *
 * Content scripts run in an ISOLATED world that has its own copy of
 * `window.history`. Patching `pushState` from there does NOT intercept the
 * page's own calls (Ember/React grab a reference at boot from the MAIN
 * world). This file runs in MAIN world at document_start so the patch lands
 * before LinkedIn's bundle caches its own reference.
 *
 * Communicates with the isolated content script via a CustomEvent on window.
 */

;(() => {
  if (window.__jobswiper_main_loaded) return
  window.__jobswiper_main_loaded = true

  // YOA-238 follow-up: LinkedIn renders the job detail panel inside closed
  // Shadow DOM on SPA-navigated pages, making document.querySelector unable
  // to find the anchor. Force all shadow roots to be open so the isolated
  // content script can traverse them. Runs at document_start in MAIN world
  // so it applies before LinkedIn's bundle attaches any shadow roots.
  try {
    const originalAttachShadow = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (init) {
      return originalAttachShadow.call(this, { ...(init || {}), mode: 'open' })
    }
  } catch {}

  const EVENT = 'jobswiper:locationchange'
  const dispatch = () => {
    try { window.dispatchEvent(new CustomEvent(EVENT)) } catch {}
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    if (typeof original !== 'function') continue
    history[method] = function (...args) {
      const result = original.apply(this, args)
      dispatch()
      return result
    }
  }

  window.addEventListener('popstate', dispatch)
  window.addEventListener('hashchange', dispatch)
})()
