/**
 * JobSwiper - Shared apply-surface helpers (form-root + fillability gate).
 *
 * This is the single real symbol that both content/autofill.js and (Phase 3)
 * content/cv-attach.js load. It is namespaced and guarded so it can never
 * double-load or collide with the capture-branch content scripts.
 *
 * Exposes exactly:
 *   window.__jobswiperApply = { resolveFormRoot, isFillableInput, SENSITIVE_DENYLIST }
 *
 * resolveFormRoot()  -> the <form> (or densest application container) to fill.
 * isFillableInput()  -> the visibility + safety gate for a single input.
 * SENSITIVE_DENYLIST -> label substrings that HARD-DISQUALIFY a field from being
 *                       filled. These are recognized ONLY to EXCLUDE, never filled.
 *
 * All logic here is read-only DOM inspection: it never fetches, never touches the
 * network, never reads auth. Authenticated fetches live in the service worker.
 */
;(function () {
  'use strict'

  // globalThis under node lets the pure denylist be unit-tested without a DOM.
  var g = typeof window !== 'undefined' ? window : globalThis
  if (g.__jobswiperApplySharedLoaded) return
  g.__jobswiperApplySharedLoaded = true

  // Label substrings that disqualify an input from ever being filled with the
  // user's own data. They cover third-party PII (references, emergency contacts,
  // previous employers), special-category / discrimination-sensitive answers
  // (gender, race, disability, veteran, EEO), and high-risk identity fields
  // (SSN, date of birth). Sensitive answers are left for the human to fill.
  var SENSITIVE_DENYLIST = [
    'confirm',
    'reference',
    'emergency',
    'manager',
    'recruiter',
    'previous employer',
    'spouse',
    'work authorization',
    'visa',
    'sponsorship',
    'citizenship',
    'gender',
    'race',
    'ethnicity',
    'disability',
    'veteran',
    'eeo',
    'salary expectation',
    'ssn',
    'social security',
    'date of birth',
  ]

  // Tokens that mark a <form> (or container) as NOT an application form. Matched
  // against class/id/name/action/role so a search box, login form, newsletter
  // subscribe, or cookie-consent form is never treated as the apply surface.
  var REJECT_TOKENS = [
    'search',
    'login',
    'log-in',
    'signin',
    'sign-in',
    'sign_in',
    'newsletter',
    'subscribe',
    'cookie',
    'consent',
  ]

  // Input types that are never fillable text fields.
  var BLOCKED_TYPES = [
    'hidden',
    'file',
    'password',
    'submit',
    'button',
    'checkbox',
    'radio',
    'image',
    'reset',
    'range',
    'color',
  ]

  function isRejectedForm(el) {
    if (!el || !el.getAttribute) return false
    var blob = (
      (el.className || '') + ' ' +
      (el.id || '') + ' ' +
      (el.getAttribute('name') || '') + ' ' +
      (el.getAttribute('action') || '') + ' ' +
      (el.getAttribute('role') || '')
    ).toLowerCase()
    if (el.getAttribute('role') === 'search') return true
    for (var i = 0; i < REJECT_TOKENS.length; i++) {
      if (blob.indexOf(REJECT_TOKENS[i]) !== -1) return true
    }
    return false
  }

  function isElementVisible(el) {
    if (!el) return false
    // offsetParent is null for display:none and detached nodes; it is also null
    // for position:fixed elements, which are legitimately visible, so allow that.
    if (el.offsetParent === null) {
      var posStyle = getComputedStyle(el)
      if (posStyle.position !== 'fixed') return false
    }
    var rect = el.getBoundingClientRect()
    if (rect.width * rect.height <= 4) return false
    // Reject inputs pushed fully outside the viewport (a common hide trick:
    // position:absolute;left:-9999px). offsetParent + area alone do not catch it.
    var vw = window.innerWidth || document.documentElement.clientWidth
    var vh = window.innerHeight || document.documentElement.clientHeight
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) return false
    var style = getComputedStyle(el)
    if (style.display === 'none') return false
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (parseFloat(style.opacity || '1') <= 0.01) return false
    return true
  }

  function hasAriaHiddenAncestor(el) {
    var node = el
    while (node && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true
      node = node.parentElement
    }
    return false
  }

  // Count visible, text-like fields under a root. Used to pick the densest
  // application region when no <form> wraps a file input.
  function applicationFieldCount(root) {
    if (!root || !root.querySelectorAll) return 0
    var fields = root.querySelectorAll('input, textarea, select')
    var n = 0
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i]
      if (f.tagName === 'INPUT') {
        var t = (f.getAttribute('type') || 'text').toLowerCase()
        if (BLOCKED_TYPES.indexOf(t) !== -1) continue
      }
      if (isElementVisible(f)) n++
    }
    return n
  }

  function densest(list) {
    var best = null
    var bestN = -1
    for (var i = 0; i < list.length; i++) {
      var n = applicationFieldCount(list[i])
      if (n > bestN) { bestN = n; best = list[i] }
    }
    return best
  }

  /**
   * Resolve the application form root:
   *   1. a non-rejected <form> containing a visible file input (the apply form),
   *   2. else the non-rejected <form> with the most visible text-like fields,
   *   3. else the densest application-scoped container (Workday-style div forms),
   * returning null when nothing looks like an application form.
   */
  function resolveFormRoot() {
    var allForms = Array.prototype.slice.call(document.querySelectorAll('form'))
    var forms = allForms.filter(function (f) { return !isRejectedForm(f) })

    var fileForms = forms.filter(function (f) {
      var inputs = f.querySelectorAll('input[type="file"]')
      for (var i = 0; i < inputs.length; i++) {
        if (isElementVisible(inputs[i])) return true
      }
      return false
    })
    if (fileForms.length) return densest(fileForms)

    var richForms = forms.filter(function (f) { return applicationFieldCount(f) >= 3 })
    if (richForms.length) return densest(richForms)

    // Div-based ATS forms (no <form> element). Scope to application-like
    // containers so we never grab the whole page.
    var containers = Array.prototype.slice.call(document.querySelectorAll(
      '[class*="application" i], [class*="apply" i], [id*="application" i], [id*="apply" i], [role="form"], main'
    )).filter(function (el) {
      return !isRejectedForm(el) && applicationFieldCount(el) >= 3
    })
    if (containers.length) return densest(containers)

    return null
  }

  /**
   * Fillability + safety gate for a single input, relative to a resolved form
   * root. Returns true only when the input is inside the root, is a text-like
   * field, is enabled, is on-screen and visible, has no aria-hidden ancestor,
   * is not removed from the tab order, and the user has not already typed a value.
   */
  function isFillableInput(input, formRoot) {
    if (!input || !formRoot) return false
    if (!formRoot.contains(input)) return false

    var tag = input.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false
    if (tag === 'INPUT') {
      var type = (input.getAttribute('type') || 'text').toLowerCase()
      if (BLOCKED_TYPES.indexOf(type) !== -1) return false
    }

    if (input.disabled || input.readOnly) return false
    if (input.getAttribute('tabindex') === '-1') return false

    // User has already typed / a value is present: never overwrite.
    if (input.value != null && String(input.value).trim() !== '') return false

    if (hasAriaHiddenAncestor(input)) return false
    if (!isElementVisible(input)) return false

    return true
  }

  // ---- event bus -----------------------------------------------------------
  // A dependency-free pub/sub so the three apply content scripts (autofill.js,
  // cv-attach.js) and the sidebar can talk over this SAME window.__jobswiperApply
  // object without any shared framework. apply-shared.js is listed FIRST in the
  // manifest apply block, so it is the one that initializes the bus; the other
  // scripts only read window.__jobswiperApply. State is a plain { evt: [cb] } map.
  //
  // emit() also retains the last payload per event so a late subscriber (the
  // sidebar loads AFTER autofill.js) can pull the current state via last(evt)
  // instead of missing an event that already fired.
  var busListeners = Object.create(null)
  var busLast = Object.create(null)

  function on(evt, cb) {
    if (!evt || typeof cb !== 'function') return function () {}
    if (!busListeners[evt]) busListeners[evt] = []
    busListeners[evt].push(cb)
    return function () { off(evt, cb) }
  }

  function off(evt, cb) {
    var arr = busListeners[evt]
    if (!arr) return
    var i = arr.indexOf(cb)
    if (i !== -1) arr.splice(i, 1)
  }

  function emit(evt, data) {
    if (!evt) return
    busLast[evt] = data
    var arr = busListeners[evt]
    if (!arr || !arr.length) return
    // Iterate a copy so a handler that unsubscribes mid-dispatch cannot make us
    // skip a sibling handler. A throwing handler must not break the others.
    var snapshot = arr.slice()
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](data) } catch (e) {}
    }
  }

  function last(evt) { return busLast[evt] }

  g.__jobswiperApply = {
    resolveFormRoot: resolveFormRoot,
    isFillableInput: isFillableInput,
    SENSITIVE_DENYLIST: SENSITIVE_DENYLIST,
    on: on,
    off: off,
    emit: emit,
    last: last,
  }

  // node-only export channel so the pure pieces (denylist, form-rejection,
  // field counting) can be exercised by node:test. Never runs in the browser.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SENSITIVE_DENYLIST: SENSITIVE_DENYLIST,
      REJECT_TOKENS: REJECT_TOKENS,
      BLOCKED_TYPES: BLOCKED_TYPES,
      isRejectedForm: isRejectedForm,
      applicationFieldCount: applicationFieldCount,
    }
  }
})()
