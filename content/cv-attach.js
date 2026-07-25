/**
 * JobSwiper - CV attach at apply (Phase 3).
 *
 * Headless module: it renders no surface of its own. The Apply sidebar
 * (content/sidebar.js) is the single UI, and it drives this module through
 * window.__jobswiperApply.attachCv(). Two outcomes on the selected CV:
 *   - Attach:   fetch the tailored PDF and place it into the page's resume input.
 *   - Download: when no safe resume input exists, hand the user a normal file
 *               download so they can drop it into any uploader themselves.
 *
 * Security posture (mirrors autofill):
 *   - This content script NEVER fetches and NEVER sees the auth token. Every
 *     network call goes content -> chrome.runtime.sendMessage -> service worker,
 *     which holds getValidToken() and fetches jobswiper.ai. The token never
 *     enters page context.
 *   - The PDF is fetched only from our origin, by uuid cvId (no page-supplied
 *     URL), with a 10 MB cap enforced in the SW.
 *   - Attach only ever targets a validated, visible, enabled, accept-compatible
 *     file input inside the resolved application form. Anything ambiguous or
 *     hidden degrades to Download with an honest toast, never a silent no-op.
 *
 * Depends on window.__jobswiperApply (content/apply-shared.js) for the form root
 * and for the event bus it reports progress and failures on. If that symbol is
 * absent, this degrades silently.
 */
;(function () {
  'use strict'

  var isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'
  if (isBrowser) {
    if (window.__jobswiperCvAttachLoaded) return
    window.__jobswiperCvAttachLoaded = true
  }

  var API_BASE = 'https://www.jobswiper.ai'
  var MAX_PDF_BYTES = 10 * 1024 * 1024

  // ---- pure helpers (node-testable, no DOM) ---------------------------------

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  function isValidUuid(s) {
    return typeof s === 'string' && UUID_RE.test(s)
  }

  // Build the download/attach filename from the server-provided base (already a
  // single-token sanitized full_name). Kept defensive so a malformed base can
  // never yield a path-ish or empty name.
  function deriveFilename(filenameBase) {
    var base = (filenameBase == null ? '' : String(filenameBase))
      .replace(/[^a-z0-9_]+/gi, '_')
      .replace(/^_+|_+$/g, '')
    if (!base) base = 'CV'
    return base + '.pdf'
  }

  // Is a PDF acceptable for this file input's accept attribute? Positive
  // allowlist: an empty accept (any file) is fine, and an accept that names any
  // document token is fine. Anything else (image-only like "image/*" or
  // ".png,.jpg", or an unknown restriction) is NOT a safe CV target and
  // degrades to Download. Better to hand the user a download than to attach a
  // PDF into a field that will reject it.
  function acceptOk(accept) {
    if (!accept) return true
    var a = String(accept).toLowerCase()
    var docTokens = ['pdf', 'doc', 'word', 'application', 'document', 'octet-stream']
    for (var i = 0; i < docTokens.length; i++) {
      if (a.indexOf(docTokens[i]) !== -1) return true
    }
    return false
  }

  // ---- resume-vs-other file-input classification (pure, node-testable) ------
  // A form can expose several uploaders (resume, cover letter, portfolio,
  // references). The resume PDF must land in the RESUME slot and never in a
  // cover-letter / portfolio field. Multilingual: cover-letter / portfolio /
  // reference / photo slots score hard-negative; a resume/cv slot scores
  // positive; anything else stays neutral (0). The DOM blob-building lives in
  // the browser layer (fileInputResumeScore); this regex classification is pure.
  var RESUME_RE = /resume|r[ée]sum[ée]|\bcv\b|curriculum|lebenslauf|hoja de vida|curriculo|currículo/i
  var NOT_RESUME_RE = /cover\s*letter|lettre de motivation|motivation|anschreiben|carta de presentaci|portfolio|reference letter|transcript|dipl[oô]me|diploma|\bphoto\b|passport|id card/i

  function scoreResumeBlob(blob) {
    if (NOT_RESUME_RE.test(blob)) return -100
    if (RESUME_RE.test(blob)) return 100
    return 0
  }

  // Given per-input resume scores, decide where to attach the resume PDF:
  //   { index }                 attach to safeInputs[index]
  //   { index:-1, ambiguous }   multiple slots, no clear winner -> user picks
  //   { index:-1, blocked }     the best/only slot is clearly NOT a resume slot
  //   { index:-1 }              nothing to attach to
  function decideAttach(scores) {
    if (!scores || !scores.length) return { index: -1 }
    var bestI = 0
    for (var i = 1; i < scores.length; i++) { if (scores[i] > scores[bestI]) bestI = i }
    var best = scores[bestI]
    if (best > 0) {
      // A tie between two positive resume slots is genuinely ambiguous.
      for (var j = 0; j < scores.length; j++) {
        if (j !== bestI && scores[j] === best) return { index: -1, ambiguous: true }
      }
      return { index: bestI }
    }
    if (best < 0) return { index: -1, blocked: true }
    if (scores.length === 1) return { index: 0 }
    return { index: -1, ambiguous: true }
  }

  // Base64 -> bytes. atob exists in both the browser and modern node, so the
  // binary round-trip is node-testable against the SW's btoa encoder.
  function base64ToBytes(base64) {
    var binary = atob(base64)
    var len = binary.length
    var bytes = new Uint8Array(len)
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  // ---- i18n (small inline table, keyed off the page locale) -----------------

  var I18N = {
    en: {
      preparing: 'Preparing your CV...',
      attached: function (n) { return 'CV attached: ' + n },
      downloaded: function (n) { return 'CV downloaded: ' + n + '. Drop it into the upload area.' },
      signInBody: 'Sign in on JobSwiper to attach your CV to this application.',
      tooLarge: 'This CV PDF is over 10 MB and cannot be attached.',
      failed: 'Could not prepare the CV. Please try again.',
      cvFallback: 'CV',
      perJobSuffix: ' (for this job)',
    },
    fr: {
      preparing: 'Preparation de ton CV...',
      attached: function (n) { return 'CV attache : ' + n },
      downloaded: function (n) { return 'CV telecharge : ' + n + ". Depose-le dans la zone d'upload." },
      signInBody: 'Connecte-toi sur JobSwiper pour attacher ton CV a cette candidature.',
      tooLarge: 'Ce PDF de CV depasse 10 Mo et ne peut pas etre attache.',
      failed: 'Impossible de preparer le CV. Reessaie.',
      cvFallback: 'CV',
      perJobSuffix: ' (pour ce poste)',
    },
    es: {
      preparing: 'Preparando tu CV...',
      attached: function (n) { return 'CV adjuntado: ' + n },
      downloaded: function (n) { return 'CV descargado: ' + n + '. Suéltalo en la zona de carga.' },
      signInBody: 'Inicia sesión en JobSwiper para adjuntar tu CV a esta candidatura.',
      tooLarge: 'Este PDF de CV supera los 10 MB y no se puede adjuntar.',
      failed: 'No se pudo preparar el CV. Inténtalo de nuevo.',
      cvFallback: 'CV',
      perJobSuffix: ' (para este puesto)',
    },
  }

  function pickLang(locale) {
    var raw = locale
    if (!raw && isBrowser) raw = document.documentElement.lang || navigator.language
    raw = (raw || 'en').toLowerCase()
    return raw.indexOf('fr') === 0 ? 'fr' : raw.indexOf('es') === 0 ? 'es' : 'en'
  }

  function t(lang) { return I18N[lang] || I18N.en }

  // ===========================================================================
  // Browser-only DOM + messaging layer. Everything above is pure/node-testable.
  // ===========================================================================
  if (isBrowser) {
    // Job context is unknown on a raw ATS page (no likedJobId source in v1), so
    // the CV list is fetched without one. A future app-triggered flow can set
    // this before the sidebar commands an attach.
    var likedJobId = null

    var lang = pickLang(null)
    var cvsData = null       // { cvs, defaultCvId, selectedCvId, filenameBase }
    var currentCvId = null
    var filename = 'CV.pdf'

    // ---- service-worker messaging (token never enters page context) ---------
    function sw(message) {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage(message, function (resp) {
            if (chrome.runtime.lastError) { resolve({ ok: false, error: 'sw' }); return }
            resolve(resp || { ok: false, error: 'empty' })
          })
        } catch (e) {
          resolve({ ok: false, error: 'throw' })
        }
      })
    }
    function getCvs() { return sw({ type: 'GET_CVS', likedJobId: likedJobId || null }) }
    function fetchCvPdf(cvId) { return sw({ type: 'FETCH_CV_PDF', cvId: cvId }) }

    // ---- file-input target validation ---------------------------------------
    function isElementVisible(el) {
      if (!el) return false
      if (el.offsetParent === null) {
        var posStyle = getComputedStyle(el)
        if (posStyle.position !== 'fixed') return false
      }
      var rect = el.getBoundingClientRect()
      if (rect.width * rect.height <= 4) return false
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

    function isSafeFileInput(el) {
      if (!el || el.tagName !== 'INPUT') return false
      if ((el.getAttribute('type') || '').toLowerCase() !== 'file') return false
      if (el.disabled || el.readOnly) return false
      if (el.getAttribute('aria-hidden') === 'true' || hasAriaHiddenAncestor(el)) return false
      if (el.tabIndex === -1 || el.getAttribute('tabindex') === '-1') return false
      if (!acceptOk(el.getAttribute('accept'))) return false
      if (!isElementVisible(el)) return false
      return true
    }

    // Safe file inputs inside the resolved application form. querySelectorAll
    // does not pierce shadow roots. On ATS hosts this script also runs INSIDE the
    // embed iframe (manifest all_frames, scoped to ATS hosts), so an iframed ATS
    // uploader is handled in its own frame; a shadow-DOM uploader still yields 0
    // here and degrades to Download.
    function resolveSafeInputs() {
      var apply = window.__jobswiperApply
      var root = apply && apply.resolveFormRoot ? apply.resolveFormRoot() : null
      if (!root) return []
      var inputs = Array.prototype.slice.call(root.querySelectorAll('input[type="file"]'))
      return inputs.filter(isSafeFileInput)
    }

    // ---- resume-vs-other file-input disambiguation --------------------------
    // A form can expose several uploaders (resume, cover letter, portfolio,
    // references). The resume PDF must land in the RESUME slot and never in a
    // cover-letter / portfolio field. We score each safe input by its labelling.
    function cssEsc(id) {
      if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(id)
      return String(id).replace(/["\\\]\[]/g, '\\$&')
    }

    // Bounded labelling text around a file input (aria + <label> + legend + a few
    // ancestors of short text), used only for classification.
    function fileInputLabelText(el) {
      var parts = []
      var lb = el.getAttribute('aria-labelledby')
      if (lb) lb.split(/\s+/).forEach(function (id) { var e = document.getElementById(id); if (e) parts.push(e.textContent || '') })
      if (el.id) { var fl = document.querySelector('label[for="' + cssEsc(el.id) + '"]'); if (fl) parts.push(fl.textContent || '') }
      var wrap = el.closest ? el.closest('label, [class*="field" i], [class*="upload" i], [class*="attach" i], fieldset') : null
      if (wrap) { var lg = wrap.querySelector('label, legend'); if (lg) parts.push(lg.textContent || '') }
      var anc = el.parentElement
      for (var d = 0; d < 3 && anc; d++) { var txt = anc.textContent || ''; if (txt.length < 300) parts.push(txt); anc = anc.parentElement }
      return parts.join(' ').slice(0, 500)
    }

    // DOM blob-building for one file input; the classification itself is the
    // pure, node-tested scoreResumeBlob above.
    function fileInputResumeScore(el) {
      var blob = [
        el.getAttribute('name') || '',
        el.id || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('accept') || '',
        fileInputLabelText(el),
      ].join(' ')
      return scoreResumeBlob(blob)
    }

    // Map the safe inputs to the attach decision (pure decideAttach) and resolve
    // the chosen element. Shape: { target, ambiguous?, blocked? }.
    function chooseAttachTarget(safeInputs) {
      if (!safeInputs || !safeInputs.length) return { target: null }
      var d = decideAttach(safeInputs.map(fileInputResumeScore))
      return { target: d.index >= 0 ? safeInputs[d.index] : null, ambiguous: d.ambiguous, blocked: d.blocked }
    }

    // ---- on-page feedback ----------------------------------------------------
    function showToast(text) {
      var toast = document.createElement('div')
      toast.className = 'jobswiper-toast'
      toast.textContent = text
      document.body.appendChild(toast)
      setTimeout(function () { toast.remove() }, 3600)
    }

    // Brand blue (#0064be), the same outline autofill draws on a filled field.
    function highlight(input) {
      var prevOutline = input.style.outline
      var prevOffset = input.style.outlineOffset
      input.style.outline = '2px solid #0064be'
      input.style.outlineOffset = '2px'
      setTimeout(function () {
        input.style.outline = prevOutline
        input.style.outlineOffset = prevOffset
      }, 2000)
    }

    // ---- attach + download --------------------------------------------------
    function triggerBlobDownload(bytes, name) {
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      var a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(function () { URL.revokeObjectURL(url) }, 4000)
    }

    // Place the PDF into a native file input, then VERIFY. Any throw or a failed
    // verify (framework rejected the assignment, isTrusted ATS, etc.) falls back
    // to a download so the user is never left with a silent no-op.
    function attachOrFallback(target, bytes, name) {
      var tr = t(lang)
      try {
        var file = new File([bytes], name, { type: 'application/pdf' })
        var dt = new DataTransfer()
        dt.items.add(file)
        target.files = dt.files
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.dispatchEvent(new Event('change', { bubbles: true }))
        if (target.files && target.files.length === 1 && target.files[0].name === name) {
          highlight(target)
          showToast(tr.attached(name))
          return
        }
      } catch (e) {
        // fall through to download
      }
      triggerBlobDownload(bytes, name)
      showToast(tr.downloaded(name))
    }

    // ---- shared apply bus ----------------------------------------------------
    // Emit on the shared bus if apply-shared.js initialized it. No-op fallback so
    // this script is safe even if it somehow loads before apply-shared.
    function emitBus(evt, data) {
      var apply = window.__jobswiperApply
      if (apply && typeof apply.emit === 'function') {
        try { apply.emit(evt, data) } catch (e) {}
      }
    }

    // The session expired mid-attach. This module owns no surface, so the failure
    // is reported on the bus and the sidebar renders the sign-in prompt: same
    // event and same payload shape as emitAuthError in content/autofill.js.
    function emitAuthError() {
      emitBus('error', {
        message: t(lang).signInBody,
        kind: 'signin',
        href: API_BASE + '/login',
      })
    }

    // Fetch the PDF once, then hand it to `then(bytes, name)`. Centralizes the
    // SW round-trip, the error surfacing, and the 10 MB / auth outcomes. Always
    // returns a promise that settles when the round-trip is done, so the caller
    // can settle its own lifecycle exactly once (never a fixed timeout that could
    // fire mid-export and double-fire a 60s Puppeteer render).
    function withPdf(setStatus, then) {
      var tr = t(lang)
      if (!isValidUuid(currentCvId)) { setStatus(tr.failed, true); return Promise.resolve() }
      setStatus(tr.preparing, false)
      return fetchCvPdf(currentCvId).then(function (resp) {
        if (!resp || resp.ok === false) {
          // Auth is the one failure with a user-actionable next step, so it goes
          // out as its own bus error on top of marking this run failed.
          if (resp && resp.error === 'auth') { emitAuthError(); setStatus(tr.signInBody, true); return }
          if (resp && resp.error === 'too_large') { setStatus(tr.tooLarge, true); return }
          setStatus(tr.failed, true)
          return
        }
        var bytes
        try { bytes = base64ToBytes(resp.base64) } catch (e) { setStatus(tr.failed, true); return }
        var name = (resp.filename && String(resp.filename)) || filename
        then(bytes, name)
      })
    }

    // ---- sidebar command wrapper (bus) --------------------------------------
    // The sidebar (content/sidebar.js) is the only UI. It drives CV attach
    // through window.__jobswiperApply.attachCv(), and listens on the bus for
    // attach {status} progress. This wrapper only ORCHESTRATES the existing flow
    // (resolveSafeInputs + withPdf + attachOrFallback); it never changes the
    // attach / file-upload logic itself.

    // Human-facing label for the CV currently selected in this module's state.
    function currentCvLabel() {
      var cvs = (cvsData && cvsData.cvs) || []
      for (var i = 0; i < cvs.length; i++) {
        if (cvs[i].id === currentCvId) {
          var label = cvs[i].title || t(lang).cvFallback
          if (cvs[i].isPerJob) label += t(lang).perJobSuffix
          return label
        }
      }
      return filename || t(lang).cvFallback
    }

    // The panel's CV choice, kept in extension storage because SELECT_CV can only
    // be recorded server-side against a saved job.
    function localSelectedCvId() {
      return new Promise(function (resolve) {
        try {
          if (!(chrome && chrome.storage && chrome.storage.local)) { resolve(null); return }
          chrome.storage.local.get('jsw_selected_cv_id', function (o) {
            resolve((o && o.jsw_selected_cv_id) || null)
          })
        } catch (e) { resolve(null) }
      })
    }

    // Ensure the CV list is loaded and a currentCvId is selected. Single SW
    // round-trip, cached after the first call; resolves true when a CV is ready.
    function ensureCvsLoaded() {
      if (cvsData && cvsData.cvs && cvsData.cvs.length && isValidUuid(currentCvId)) {
        return Promise.resolve(true)
      }
      return getCvs().then(function (resp) {
        if (!resp || resp.ok === false) return false
        cvsData = resp
        if (!resp.cvs || !resp.cvs.length) return false
        filename = deriveFilename(resp.filenameBase)
        // A CV picked in the panel on a raw ATS page has no saved job to be
        // recorded against server-side, so the choice is also kept locally.
        // Honour it here, but only if that CV still exists in the account.
        return localSelectedCvId().then(function (local) {
          var localOk = false
          if (local) {
            for (var i = 0; i < resp.cvs.length; i++) { if (resp.cvs[i].id === local) { localOk = true; break } }
          }
          currentCvId = (localOk ? local : null) || resp.selectedCvId || resp.defaultCvId || resp.cvs[0].id
          return true
        })
      })
    }

    // Command the sidebar calls: attach the selected CV into the resolved resume
    // field, emitting attach {status:"attaching"|"done"|"error", cvName} as it
    // goes. Where to attach (resume slot vs honest download fallback) is governed
    // by chooseAttachTarget; attachOrFallback still owns the actual native-input
    // assignment + verify.
    function attachCv() {
      var tr = t(lang)
      var cvName = currentCvLabel()
      emitBus('attach', { status: 'attaching', cvName: cvName })
      return ensureCvsLoaded().then(function (ready) {
        if (!ready) {
          emitBus('attach', { status: 'error', cvName: cvName })
          return
        }
        cvName = currentCvLabel()
        var safe = resolveSafeInputs()
        var choice = chooseAttachTarget(safe)
        var attached = false
        var errored = false
        function statusShim(text, isErr) { if (isErr) errored = true }
        return withPdf(statusShim, function (bytes, name) {
          cvName = name || cvName
          if (choice.target) {
            // Attach to the best resume-matched field, not blindly the first.
            attachOrFallback(choice.target, bytes, name)
          } else {
            // No safe input, an ambiguous multi-field form (the sidebar has no
            // on-page click-to-pick step), or a non-resume-only slot: honest
            // download fallback.
            triggerBlobDownload(bytes, name)
            showToast(tr.downloaded(name))
          }
          attached = true
        }).then(function () {
          emitBus('attach', { status: (attached && !errored) ? 'done' : 'error', cvName: cvName })
        })
      })
    }

    // Register the command on the shared object (apply-shared.js owns it and is
    // listed first in the manifest apply block; fall back to a bare object if it
    // is somehow missing so registration never throws).
    var applyObj = window.__jobswiperApply || (window.__jobswiperApply = {})
    applyObj.attachCv = attachCv
  }

  // node-only export channel for the pure helpers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      isValidUuid: isValidUuid,
      deriveFilename: deriveFilename,
      acceptOk: acceptOk,
      scoreResumeBlob: scoreResumeBlob,
      decideAttach: decideAttach,
      base64ToBytes: base64ToBytes,
      MAX_PDF_BYTES: MAX_PDF_BYTES,
    }
  }
})()
