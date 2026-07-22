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

  // ---- is-this-a-job-application gate --------------------------------------
  // Because the apply layer now injects broadly (manifest matches https://*/*),
  // EVERY page runs this cheap gate before anything renders or observes. It is
  // structured for early exits: a known-ATS host short-circuits to true with no
  // DOM work; an obviously-non-job surface (search engines, webmail, social, AI
  // chat, dev tools) short-circuits to false with no DOM work; only an
  // unclassified page pays for a bounded DOM scan. Everything is read-only.

  // Known ATS host substrings. A match here is a hard YES (the page is an
  // application surface by construction), bypassing every heuristic. Substrings,
  // matched against location.hostname (competitor uses the same bare-substring
  // approach). smartapply.indeed.com is included so the broad match folds in the
  // old dedicated Indeed apply block.
  var KNOWN_ATS_HOSTS = [
    'greenhouse.io',
    'lever.co',
    'smartrecruiters.com',
    'ashbyhq.com',
    'recruitee.com',
    'myworkdayjobs.com',
    'successfactors.com',
    'successfactors.eu',
    'sapsf.com',
    'sapsf.eu',
    'oraclecloud.com',
    'workforcenow.adp.com',
    'myjobs.adp.com',
    'csod.com',
    'avature.net',
    'eightfold.ai',
    'jobvite.com',
    'ultipro.com',
    'amazon.jobs',
    'icims.com',
    'workable.com',
    'breezy.hr',
    'bamboohr.com',
    'jazz.co',
    'applytojob.com',
    'smartapply.indeed.com',
  ]

  // Hard-NO host substrings: pages that are never a job application. Checked
  // BEFORE any DOM work so the gate stays cheap on the sites people keep open.
  var HOST_BLOCKLIST = [
    'mail.google.com', 'docs.google.com', 'calendar.google.com', 'drive.google.com', 'meet.google.com',
    'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai', 'poe.com',
    'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'figma.com', 'notion.so',
    'trello.com', 'atlassian.net', 'slack.com', 'discord.com',
    'youtube.com', 'reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com',
    'pinterest.com', 'whatsapp.com', 'telegram.org', 'twitch.tv',
    'wikipedia.org', 'medium.com', 'substack.com', 'netflix.com', 'spotify.com',
  ]

  function matchesKnownAts(host) {
    host = (host || '').toLowerCase()
    for (var i = 0; i < KNOWN_ATS_HOSTS.length; i++) {
      if (host.indexOf(KNOWN_ATS_HOSTS[i]) !== -1) return true
    }
    return false
  }

  // Non-job surfaces that share a host with legitimate targets and so need a
  // path check: search-engine result pages, and LinkedIn everywhere except
  // /jobs. Returns true when the URL is a hard-NO surface.
  function isBlockedSurface(host, path) {
    host = (host || '').toLowerCase()
    path = (path || '').toLowerCase()
    for (var i = 0; i < HOST_BLOCKLIST.length; i++) {
      if (host.indexOf(HOST_BLOCKLIST[i]) !== -1) return true
    }
    // Search-engine RESULT pages only (their /search path), not the whole host.
    if (host.indexOf('google.') !== -1 && path.indexOf('/search') === 0) return true
    if (host.indexOf('bing.com') !== -1 && path.indexOf('/search') === 0) return true
    if (host.indexOf('duckduckgo.com') !== -1) return true
    if (host.indexOf('search.brave.com') !== -1) return true
    if (host.indexOf('search.yahoo.com') !== -1) return true
    if (host.indexOf('ecosia.org') !== -1) return true
    if (host.indexOf('qwant.com') !== -1) return true
    // LinkedIn: only /jobs surfaces are application-relevant (the linkedin.js
    // capture script owns the rest). Everything else on linkedin is a hard NO.
    if (host.indexOf('linkedin.com') !== -1 &&
        path.indexOf('/jobs') !== 0 && path.indexOf('/comm/jobs') !== 0) return true
    return false
  }

  // Text signals. Kept multilingual (EN/FR/ES/DE) but small.
  var APPLY_INTENT_RE = /(submit application|apply now|apply for|easy apply|start your application|complete application|postuler|candidature|d[ée]poser ma candidature|solicitar empleo|enviar solicitud|inscribirse|aplicar ahora|jetzt bewerben|bewerbung|bewerben)/i
  var RESUME_CTX_RE = /(resume|r[ée]sum[ée]|\bcv\b|curriculum|cover letter|lettre de motivation|lebenslauf|hoja de vida)/i
  var IDENTITY_RE = /(first[\s_-]?name|last[\s_-]?name|full[\s_-]?name|\bname\b|e-?mail|phone|mobile|t[ée]l[ée]phone|pr[ée]nom|\bnom\b|correo|tel[ée]fono|nombre|apellido|vorname|nachname)/i

  // A resume/CV file input, judged by its own attributes and a bounded slice of
  // nearby text. Strong single signal of an application surface.
  function looksLikeResumeFileInput() {
    var files = document.querySelectorAll('input[type="file"]')
    var cap = files.length < 12 ? files.length : 12
    for (var i = 0; i < cap; i++) {
      var f = files[i]
      if (!isElementVisible(f)) continue
      var blob = (
        (f.getAttribute('accept') || '') + ' ' +
        (f.getAttribute('name') || '') + ' ' +
        (f.id || '') + ' ' +
        (f.getAttribute('aria-label') || '')
      ).toLowerCase()
      if (RESUME_CTX_RE.test(blob)) return true
      var anc = f
      for (var d = 0; d < 4 && anc; d++) {
        anc = anc.parentElement
        if (anc) {
          var txt = anc.textContent || ''
          if (txt.length < 400 && RESUME_CTX_RE.test(txt)) return true
        }
      }
    }
    return false
  }

  // Apply-intent text on a bounded set of action-ish elements.
  function hasApplyIntentText() {
    var els = document.querySelectorAll(
      'button, input[type="submit"], input[type="button"], a[role="button"], [class*="apply" i], h1, h2'
    )
    var cap = els.length < 60 ? els.length : 60
    for (var i = 0; i < cap; i++) {
      var e = els[i]
      var s = e.value || e.textContent || e.getAttribute('aria-label') || ''
      if (s && s.length < 140 && APPLY_INTENT_RE.test(s)) return true
    }
    return false
  }

  // Count identity-labelled visible fields inside a scope, and note whether a
  // password field is present (so a login form is not mistaken for an apply
  // form). Bounded scan.
  function identitySignal(scope) {
    var root = scope || document
    var inputs = root.querySelectorAll('input, textarea')
    var cap = inputs.length < 80 ? inputs.length : 80
    var count = 0
    var sawPassword = false
    for (var i = 0; i < cap; i++) {
      var f = inputs[i]
      if (f.tagName === 'INPUT') {
        var ty = (f.getAttribute('type') || 'text').toLowerCase()
        if (ty === 'password') { sawPassword = true; continue }
        if (BLOCKED_TYPES.indexOf(ty) !== -1) continue
      }
      if (!isElementVisible(f)) continue
      var blob = (
        (f.getAttribute('name') || '') + ' ' +
        (f.id || '') + ' ' +
        (f.getAttribute('placeholder') || '') + ' ' +
        (f.getAttribute('aria-label') || '') + ' ' +
        (f.getAttribute('autocomplete') || '')
      ).toLowerCase()
      if (IDENTITY_RE.test(blob)) count++
    }
    return { count: count, sawPassword: sawPassword }
  }

  // Raw (uncached) decision. Order is chosen so the common cases are cheapest:
  //   known ATS host  -> YES, no DOM
  //   blocked surface -> NO, no DOM
  //   resume file input present in a form context -> YES
  //   apply-intent text + >=2 identity fields in a form root -> YES
  //   otherwise -> NO
  function computeIsLikelyJobApplication() {
    try {
      var host = (location.hostname || '').toLowerCase()
      var path = (location.pathname || '').toLowerCase()
      if (matchesKnownAts(host)) return true
      if (isBlockedSurface(host, path)) return false

      var root = resolveFormRoot()

      // Strong: a resume/CV upload, as long as it sits in some form-ish context
      // (a resolvable root or explicit apply-intent), never a lone media widget.
      if (looksLikeResumeFileInput()) {
        return !!root || hasApplyIntentText()
      }

      // Otherwise require BOTH an application form root AND apply-intent text AND
      // at least two identity fields. This is what keeps login/search/newsletter
      // pages out: a lone email (+ password) never clears the bar.
      if (!root) return false
      var idf = identitySignal(root)
      if (idf.sawPassword && idf.count < 3) return false
      if (idf.count >= 2 && hasApplyIntentText()) return true
      return false
    } catch (e) {
      return false
    }
  }

  // Cached wrapper (the one the gating points call, so the broad injection stays
  // cheap when the same page pings the gate repeatedly). The cache key is the
  // current URL, so an SPA navigation naturally invalidates it. A positive is
  // sticky for the URL (once an application, always an application for that URL);
  // a negative is memoised only briefly so a late-rendering form is re-evaluated
  // on the next call instead of being locked out.
  var _likelyHref = null
  var _likelyVal = false
  var _likelyTrue = false
  var _likelyAt = 0
  var NEG_TTL_MS = 1500

  function isLikelyJobApplication(opts) {
    var href = (typeof location !== 'undefined' && location.href) || ''
    var now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0
    if (opts && opts.fresh) { _likelyHref = null }
    if (_likelyHref === href) {
      if (_likelyTrue) return true
      if (now - _likelyAt < NEG_TTL_MS) return _likelyVal
    } else {
      _likelyTrue = false
    }
    var val = computeIsLikelyJobApplication()
    _likelyHref = href
    _likelyVal = val
    _likelyAt = now
    if (val) _likelyTrue = true
    return val
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
    // Cheap cached gate the apply layer checks before rendering/observing.
    isLikelyJobApplication: isLikelyJobApplication,
    // Uncached raw decision (forces a fresh DOM scan).
    isLikelyJobApplicationNow: computeIsLikelyJobApplication,
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
      KNOWN_ATS_HOSTS: KNOWN_ATS_HOSTS,
      HOST_BLOCKLIST: HOST_BLOCKLIST,
      isRejectedForm: isRejectedForm,
      applicationFieldCount: applicationFieldCount,
      matchesKnownAts: matchesKnownAts,
      isBlockedSurface: isBlockedSurface,
    }
  }
})()
