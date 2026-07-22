/**
 * JobSwiper - CV attach at apply (Phase 3).
 *
 * On an ATS application page this renders ONE compact control group inside a
 * CLOSED shadow root (the same isolation autofill uses). It offers two
 * first-class actions on a user-picked CV:
 *   - Attach CV: fetch the tailored PDF and place it into the page's file input.
 *   - Download:  fetch the same PDF and hand the user a normal file download,
 *                so they can drop it into any uploader themselves.
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
 * Depends on window.__jobswiperApply (content/apply-shared.js) for the form
 * root. If that symbol is absent, this degrades silently (no control renders).
 */
;(function () {
  'use strict'

  // i18n message helper: resolves a key via chrome.i18n, falling back to the key.

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

  // Given the count of safe file inputs, decide the flow.
  function selectMode(safeCount) {
    if (safeCount === 1) return 'attach'
    if (safeCount > 1) return 'pick'
    return 'download'
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
      trigger: 'Attach your CV',
      title: 'CV for this application',
      subtitle: 'Attach it into the upload field, or download it to drop in yourself.',
      attach: 'Attach CV',
      download: 'Download',
      preparing: 'Preparing your CV...',
      attached: function (n) { return 'CV attached: ' + n },
      downloaded: function (n) { return 'CV downloaded: ' + n + '. Drop it into the upload area.' },
      pickTitle: 'Pick the upload field',
      pickBody: 'Click the CV / resume upload field highlighted on the page.',
      cancel: 'Cancel',
      close: 'Close',
      noCvsTitle: 'No CV yet',
      noCvsBody: 'Generate a CV on JobSwiper, then attach it from here.',
      openCta: 'Open JobSwiper',
      signInTitle: 'Sign in to JobSwiper',
      signInBody: 'Sign in on JobSwiper to attach your CV to this application.',
      errorTitle: 'Could not load your CVs',
      errorBody: 'Open JobSwiper to check you are signed in, then reopen this.',
      tooLarge: 'This CV PDF is over 10 MB and cannot be attached.',
      failed: 'Could not prepare the CV. Please try again.',
      cvFallback: 'CV',
      perJobSuffix: ' (for this job)',
    },
    fr: {
      trigger: 'Attacher ton CV',
      title: 'CV pour cette candidature',
      subtitle: "Attache-le dans le champ d'upload, ou telecharge-le pour le deposer toi-meme.",
      attach: 'Attacher le CV',
      download: 'Telecharger',
      preparing: 'Preparation de ton CV...',
      attached: function (n) { return 'CV attache : ' + n },
      downloaded: function (n) { return 'CV telecharge : ' + n + ". Depose-le dans la zone d'upload." },
      pickTitle: "Choisis le champ d'upload",
      pickBody: "Clique sur le champ d'upload du CV mis en evidence sur la page.",
      cancel: 'Annuler',
      close: 'Fermer',
      noCvsTitle: 'Aucun CV pour le moment',
      noCvsBody: 'Genere un CV sur JobSwiper, puis attache-le depuis ici.',
      openCta: 'Ouvrir JobSwiper',
      signInTitle: 'Connecte-toi a JobSwiper',
      signInBody: 'Connecte-toi sur JobSwiper pour attacher ton CV a cette candidature.',
      errorTitle: 'Impossible de charger tes CV',
      errorBody: 'Ouvre JobSwiper pour verifier que tu es connecte, puis rouvre ceci.',
      tooLarge: 'Ce PDF de CV depasse 10 Mo et ne peut pas etre attache.',
      failed: 'Impossible de preparer le CV. Reessaie.',
      cvFallback: 'CV',
      perJobSuffix: ' (pour ce poste)',
    },
    es: {
      trigger: 'Adjunta tu CV',
      title: 'CV para esta candidatura',
      subtitle: 'Adjúntalo en el campo de carga, o descárgalo para soltarlo tú mismo.',
      attach: 'Adjuntar CV',
      download: 'Descargar',
      preparing: 'Preparando tu CV...',
      attached: function (n) { return 'CV adjuntado: ' + n },
      downloaded: function (n) { return 'CV descargado: ' + n + '. Suéltalo en la zona de carga.' },
      pickTitle: 'Elige el campo de carga',
      pickBody: 'Haz clic en el campo de carga del CV resaltado en la página.',
      cancel: 'Cancelar',
      close: 'Cerrar',
      noCvsTitle: 'Aún no hay CV',
      noCvsBody: 'Genera un CV en JobSwiper y luego adjúntalo desde aquí.',
      openCta: 'Abrir JobSwiper',
      signInTitle: 'Inicia sesión en JobSwiper',
      signInBody: 'Inicia sesión en JobSwiper para adjuntar tu CV a esta candidatura.',
      errorTitle: 'No se pudieron cargar tus CV',
      errorBody: 'Abre JobSwiper para comprobar que has iniciado sesión y vuelve a abrir esto.',
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
    // the CV list is fetched without one and the user picks. A future
    // app-triggered flow can set this before opening the control.
    var likedJobId = null

    var lang = pickLang(null)
    var cvsData = null       // { cvs, defaultCvId, selectedCvId, filenameBase }
    var currentCvId = null
    var filename = 'CV.pdf'
    var loadingCvs = false
    var busy = false

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
    function selectCv(cvId) { return sw({ type: 'SELECT_CV', likedJobId: likedJobId, cvId: cvId }) }

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
    // does not pierce shadow roots and we never inject into iframes (top-frame
    // only, no all_frames), so shadow-DOM / iframed uploaders yield 0 here and
    // degrade to Download.
    function resolveSafeInputs() {
      var apply = window.__jobswiperApply
      var root = apply && apply.resolveFormRoot ? apply.resolveFormRoot() : null
      if (!root) return []
      var inputs = Array.prototype.slice.call(root.querySelectorAll('input[type="file"]'))
      return inputs.filter(isSafeFileInput)
    }

    // ---- closed-shadow overlay ----------------------------------------------
    var PANEL_STYLE = [
      ':host { all: initial; }',
      '.wrap { position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;',
      '  width: 340px; max-width: calc(100vw - 32px); background: #ffffff;',
      '  border: 1px solid rgba(0,0,0,0.12); border-radius: 12px;',
      '  box-shadow: 0 8px 28px rgba(0,0,0,0.18);',
      '  font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  color: #111827; overflow: hidden; }',
      '.hd { padding: 14px 16px 8px; }',
      '.title { font-size: 15px; font-weight: 700; margin: 0 0 2px; }',
      '.sub { font-size: 12px; color: #6b7280; margin: 0; line-height: 1.4; }',
      '.body { padding: 8px 16px 2px; }',
      '.select { width: 100%; box-sizing: border-box; font-size: 13px; font-family: inherit;',
      '  color: #111827; padding: 9px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.16);',
      '  background: #ffffff; }',
      '.status { padding: 6px 16px 0; font-size: 12px; color: #6b7280; min-height: 0; }',
      '.status.err { color: #b91c1c; }',
      '.ft { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px 14px; }',
      '.btn { font-size: 13px; font-weight: 600; padding: 9px 14px; border-radius: 8px;',
      '  border: 1px solid transparent; cursor: pointer; font-family: inherit; }',
      '.btn:disabled { opacity: 0.55; cursor: default; }',
      '.ghost { background: transparent; border-color: rgba(0,0,0,0.16); color: #1e4b8e; }',
      '.ghost:hover:not(:disabled) { background: rgba(30,75,142,0.06); }',
      '.primary { background: #1e4b8e; color: #ffffff; }',
      '.primary:hover:not(:disabled) { background: #163a6f; }',
      '.linkbody { padding: 4px 16px 2px; font-size: 13px; color: #374151; line-height: 1.45; }',
      'a.primary { text-decoration: none; display: inline-block; }',
    ].join('\n')

    var activeHost = null

    function closePanel() {
      if (activeHost) {
        activeHost.remove()
        activeHost = null
      }
    }

    function openPanel(build) {
      closePanel()
      var host = document.createElement('div')
      host.className = 'jobswiper-cv-attach-host'
      var root = host.attachShadow({ mode: 'closed' })
      var style = document.createElement('style')
      style.textContent = PANEL_STYLE
      root.appendChild(style)
      var wrap = document.createElement('div')
      wrap.className = 'wrap'
      build(wrap, root)
      root.appendChild(wrap)
      document.body.appendChild(host)
      activeHost = host
    }

    function el(tag, cls, text) {
      var node = document.createElement(tag)
      if (cls) node.className = cls
      if (text != null) node.textContent = text
      return node
    }

    function showToast(text) {
      var toast = document.createElement('div')
      toast.className = 'jobswiper-toast'
      toast.textContent = text
      document.body.appendChild(toast)
      setTimeout(function () { toast.remove() }, 3600)
    }

    function highlight(input) {
      var prevOutline = input.style.outline
      var prevOffset = input.style.outlineOffset
      input.style.outline = '2px solid #1e4b8e'
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
          closePanel()
          highlight(target)
          showToast(tr.attached(name))
          return
        }
      } catch (e) {
        // fall through to download
      }
      closePanel()
      triggerBlobDownload(bytes, name)
      showToast(tr.downloaded(name))
    }

    // Fetch the PDF once, then hand it to `then(bytes, name)`. Centralizes the
    // SW round-trip, the error surfacing, and the 10 MB / auth outcomes. Always
    // returns a promise that settles when the round-trip is done, so the caller
    // can re-enable its buttons exactly once (never a fixed timeout that could
    // re-enable mid-export and double-fire a 60s Puppeteer render).
    function withPdf(setStatus, then) {
      var tr = t(lang)
      if (!isValidUuid(currentCvId)) { setStatus(tr.failed, true); return Promise.resolve() }
      setStatus(tr.preparing, false)
      return fetchCvPdf(currentCvId).then(function (resp) {
        if (!resp || resp.ok === false) {
          if (resp && resp.error === 'auth') { openLinkPanel('signin'); return }
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

    // ---- pick mode (more than one safe file input) --------------------------
    function enterPickMode(safeInputs) {
      var tr = t(lang)
      var cleanups = []
      function teardown() {
        for (var i = 0; i < cleanups.length; i++) cleanups[i]()
        cleanups = []
      }
      safeInputs.forEach(function (input) {
        var prevOutline = input.style.outline
        var prevOffset = input.style.outlineOffset
        input.style.outline = '2px solid #1e4b8e'
        input.style.outlineOffset = '2px'
        function onPick(e) {
          // Prevent the native OS file dialog: we assign files programmatically.
          e.preventDefault()
          e.stopPropagation()
          teardown()
          proceedAttachTo(input)
        }
        input.addEventListener('click', onPick, { capture: true })
        cleanups.push(function () {
          input.style.outline = prevOutline
          input.style.outlineOffset = prevOffset
          input.removeEventListener('click', onPick, true)
        })
      })

      openPanel(function (wrap) {
        var hd = el('div', 'hd')
        hd.appendChild(el('p', 'title', tr.pickTitle))
        hd.appendChild(el('p', 'sub', tr.pickBody))
        wrap.appendChild(hd)
        var ft = el('div', 'ft')
        var cancel = el('button', 'btn ghost', tr.cancel)
        cancel.addEventListener('click', function () { teardown(); closePanel() })
        ft.appendChild(cancel)
        wrap.appendChild(ft)
      })
    }

    function proceedAttachTo(target) {
      openControlPanel()
      var setStatus = window.__jobswiperCvAttachSetStatus || function () {}
      withPdf(setStatus, function (bytes, name) {
        attachOrFallback(target, bytes, name)
      })
    }

    // ---- main control panel -------------------------------------------------
    function openControlPanel() {
      var tr = t(lang)
      openPanel(function (wrap) {
        var hd = el('div', 'hd')
        hd.appendChild(el('p', 'title', tr.title))
        hd.appendChild(el('p', 'sub', tr.subtitle))
        wrap.appendChild(hd)

        var body = el('div', 'body')
        var select = document.createElement('select')
        select.className = 'select'
        var cvs = (cvsData && cvsData.cvs) || []
        for (var i = 0; i < cvs.length; i++) {
          var opt = document.createElement('option')
          opt.value = cvs[i].id
          var label = cvs[i].title || t(lang).cvFallback
          if (cvs[i].isPerJob) label += t(lang).perJobSuffix
          opt.textContent = label
          if (cvs[i].id === currentCvId) opt.selected = true
          select.appendChild(opt)
        }
        select.addEventListener('change', function () {
          currentCvId = select.value
          // Persist the choice only when we know which job it is (app-triggered
          // flow). On a raw ATS page likedJobId is null and this is a no-op.
          if (likedJobId && isValidUuid(currentCvId)) selectCv(currentCvId)
        })
        body.appendChild(select)
        wrap.appendChild(body)

        var status = el('div', 'status', '')
        wrap.appendChild(status)
        function setStatus(text, isErr) {
          status.textContent = text || ''
          status.className = isErr ? 'status err' : 'status'
        }
        window.__jobswiperCvAttachSetStatus = setStatus

        var ft = el('div', 'ft')
        var downloadBtn = el('button', 'btn ghost', tr.download)
        var attachBtn = el('button', 'btn primary', tr.attach)

        function setBusy(on) {
          busy = on
          downloadBtn.disabled = on
          attachBtn.disabled = on
        }

        downloadBtn.addEventListener('click', function () {
          if (busy) return
          setBusy(true)
          withPdf(setStatus, function (bytes, name) {
            closePanel()
            triggerBlobDownload(bytes, name)
            showToast(tr.downloaded(name))
          }).then(function () { setBusy(false) })
        })

        attachBtn.addEventListener('click', function () {
          if (busy) return
          var safe = resolveSafeInputs()
          var mode = selectMode(safe.length)
          if (mode === 'pick') { enterPickMode(safe); return }
          setBusy(true)
          withPdf(setStatus, function (bytes, name) {
            if (mode === 'attach') {
              attachOrFallback(safe[0], bytes, name)
            } else {
              // No safe native input: honest download fallback.
              closePanel()
              triggerBlobDownload(bytes, name)
              showToast(tr.downloaded(name))
            }
          }).then(function () { setBusy(false) })
        })

        ft.appendChild(downloadBtn)
        ft.appendChild(attachBtn)
        wrap.appendChild(ft)
      })
    }

    function openInfoPanel(title, body) {
      openPanel(function (wrap) {
        var hd = el('div', 'hd')
        hd.appendChild(el('p', 'title', title))
        wrap.appendChild(hd)
        wrap.appendChild(el('div', 'linkbody', body))
        var ft = el('div', 'ft')
        var close = el('button', 'btn ghost', t(lang).close)
        close.addEventListener('click', closePanel)
        var link = el('a', 'btn primary', t(lang).openCta)
        link.href = API_BASE + '/dashboard/cvs'
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.addEventListener('click', closePanel)
        ft.appendChild(close)
        ft.appendChild(link)
        wrap.appendChild(ft)
      })
    }

    function openLinkPanel(kind) {
      var tr = t(lang)
      var title = kind === 'signin' ? tr.signInTitle : tr.errorTitle
      var bodyText = kind === 'signin' ? tr.signInBody : tr.errorBody
      var href = kind === 'signin' ? (API_BASE + '/login') : (API_BASE + '/dashboard/cvs')
      openPanel(function (wrap) {
        var hd = el('div', 'hd')
        hd.appendChild(el('p', 'title', title))
        wrap.appendChild(hd)
        wrap.appendChild(el('div', 'linkbody', bodyText))
        var ft = el('div', 'ft')
        var close = el('button', 'btn ghost', tr.close)
        close.addEventListener('click', closePanel)
        var link = el('a', 'btn primary', tr.openCta)
        link.href = href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.addEventListener('click', closePanel)
        ft.appendChild(close)
        ft.appendChild(link)
        wrap.appendChild(ft)
      })
    }

    // ---- trigger + lazy CV load ---------------------------------------------
    function onTriggerClick() {
      if (loadingCvs) return
      if (cvsData && cvsData.cvs && cvsData.cvs.length) { openControlPanel(); return }
      loadingCvs = true
      getCvs().then(function (resp) {
        loadingCvs = false
        if (!resp || resp.ok === false) {
          if (resp && resp.error === 'auth') { openLinkPanel('signin'); return }
          openLinkPanel('error')
          return
        }
        cvsData = resp
        if (!resp.cvs || !resp.cvs.length) {
          openInfoPanel(t(lang).noCvsTitle, t(lang).noCvsBody)
          return
        }
        currentCvId = resp.selectedCvId || resp.defaultCvId || resp.cvs[0].id
        filename = deriveFilename(resp.filenameBase)
        openControlPanel()
      })
    }

    // ---- sidebar command wrapper (bus) --------------------------------------
    // The sidebar (content/autofill.js surface) is the primary UI. It drives CV
    // attach through window.__jobswiperApply.attachCv(), and listens on the bus
    // for attach {status} progress. This wrapper only ORCHESTRATES the existing
    // flow (resolveSafeInputs + withPdf + attachOrFallback); it never changes the
    // attach / file-upload logic itself.

    // Emit on the shared bus if apply-shared.js initialized it. No-op fallback so
    // this script is safe even if it somehow loads before apply-shared.
    function emitBus(evt, data) {
      var apply = window.__jobswiperApply
      if (apply && typeof apply.emit === 'function') {
        try { apply.emit(evt, data) } catch (e) {}
      }
    }

    // Human-facing label for the CV currently selected in this control's state.
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

    // Ensure the CV list is loaded and a currentCvId is selected. Reuses the same
    // SW round-trip as the trigger flow; resolves true when a CV is ready.
    function ensureCvsLoaded() {
      if (cvsData && cvsData.cvs && cvsData.cvs.length && isValidUuid(currentCvId)) {
        return Promise.resolve(true)
      }
      return getCvs().then(function (resp) {
        if (!resp || resp.ok === false) return false
        cvsData = resp
        if (!resp.cvs || !resp.cvs.length) return false
        currentCvId = resp.selectedCvId || resp.defaultCvId || resp.cvs[0].id
        filename = deriveFilename(resp.filenameBase)
        return true
      })
    }

    // Command the sidebar calls: attach the selected CV into the resolved resume
    // field, emitting attach {status:"attaching"|"done"|"error", cvName} as it
    // goes. Runs headless (no closed-shadow panel) so the sidebar stays the only
    // surface. Attach vs honest download fallback stays governed by the untouched
    // attachOrFallback / selectMode logic.
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
        var mode = selectMode(safe.length)
        var attached = false
        var errored = false
        function statusShim(text, isErr) { if (isErr) errored = true }
        return withPdf(statusShim, function (bytes, name) {
          cvName = name || cvName
          if (mode === 'download') {
            // No safe native input: honest download fallback, same as the panel.
            triggerBlobDownload(bytes, name)
            showToast(tr.downloaded(name))
          } else {
            // mode 'attach' or 'pick': place into the first safe input. The
            // sidebar drives selection, so there is no on-page click-to-pick step.
            attachOrFallback(safe[0], bytes, name)
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

    // ---- trigger injection + SPA re-injection -------------------------------
    function injectTrigger() {
      // The Apply sidebar (content/sidebar.js) is now the single surface: it
      // drives CV attach through window.__jobswiperApply.attachCv(). The old
      // standalone bottom-right trigger + control panel below are kept for
      // reference but never rendered, so there is no double UI.
      return
      // eslint-disable-next-line no-unreachable
      if (document.querySelector('.jobswiper-cv-attach-btn')) return
      var apply = window.__jobswiperApply
      // apply-shared.js provides the form root. If it is not present, degrade
      // silently (no control) rather than guessing the form.
      if (!apply || !apply.resolveFormRoot) return
      if (!apply.resolveFormRoot()) return

      var btn = document.createElement('button')
      btn.className = 'jobswiper-save-btn jobswiper-cv-attach-btn'
      btn.type = 'button'
      // Stacked ABOVE the autofill button (bottom:24) so the two never overlap.
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> '
      btn.appendChild(document.createTextNode(t(lang).trigger))
      btn.style.cssText = 'position:fixed;bottom:76px;right:24px;z-index:2147483646;'
      btn.addEventListener('click', onTriggerClick)
      document.body.appendChild(btn)
    }

    function removeTriggerIfGone() {
      var apply = window.__jobswiperApply
      if (!apply || !apply.resolveFormRoot) return
      if (!apply.resolveFormRoot()) {
        var existing = document.querySelector('.jobswiper-cv-attach-btn')
        if (existing) existing.remove()
        closePanel()
      }
    }

    var debounceTimer = null
    function scheduleScan() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(function () {
        removeTriggerIfGone()
        injectTrigger()
      }, 500)
    }

    var observer = null
    function startObserver() {
      if (observer || !document.body) return
      observer = new MutationObserver(scheduleScan)
      observer.observe(document.body, { childList: true, subtree: true })
    }

    var navHooked = false
    function hookHistory() {
      if (navHooked) return
      navHooked = true
      var origPush = history.pushState
      history.pushState = function () {
        var ret = origPush.apply(this, arguments)
        onNav()
        return ret
      }
      window.addEventListener('popstate', onNav)
    }

    function onNav() {
      if (observer) { scheduleScan(); return }
      armIfLikely()
    }

    function armIfLikely() {
      var apply = window.__jobswiperApply
      if (apply && apply.isLikelyJobApplication && !apply.isLikelyJobApplication()) return
      injectTrigger()
      startObserver()
    }

    window.addEventListener('pagehide', function () {
      if (observer) { observer.disconnect(); observer = null }
      if (debounceTimer) clearTimeout(debounceTimer)
    })

    // Broad injection: always hook the cheap SPA-nav listener, but only arm the
    // observer once the page looks like a job application. attachCv stays
    // registered on window.__jobswiperApply regardless (the sidebar drives it).
    function boot() {
      hookHistory()
      armIfLikely()
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 900) })
    } else {
      setTimeout(boot, 900)
    }
  }

  // node-only export channel for the pure helpers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      isValidUuid: isValidUuid,
      deriveFilename: deriveFilename,
      acceptOk: acceptOk,
      selectMode: selectMode,
      base64ToBytes: base64ToBytes,
      MAX_PDF_BYTES: MAX_PDF_BYTES,
    }
  }
})()
