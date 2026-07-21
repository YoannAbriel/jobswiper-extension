/**
 * JobSwiper - Application form autofill (v2, honest + secure).
 *
 * Replaces the old spray-fill path. What changed and why:
 *   - The dead loadProfile / stats._profile path is gone. The profile now comes
 *     from the service worker (GET_PROFILE), which is the only place the auth
 *     token lives. This content script never fetches and never sees a token.
 *   - Fields are chosen by best-match scoring with a global one-input-one-field
 *     assignment, not first-match, so two "name" inputs can no longer both grab
 *     the full name.
 *   - Nothing is written until the user confirms a review panel rendered in a
 *     CLOSED shadow root, so page-context JS cannot scrape the proposed values.
 *   - Sensitive / third-party fields (references, EEO, visa, gender, ...) are
 *     recognized only to EXCLUDE them, never filled.
 *   - The form root, visibility gate, and denylist come from the shared module
 *     window.__jobswiperApply (content/apply-shared.js).
 *
 * Never auto-submits: only input/change/blur are dispatched.
 */
;(function () {
  'use strict'

  var isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'
  if (isBrowser) {
    if (window.__jobswiperAutofillLoaded) return
    window.__jobswiperAutofillLoaded = true
  }

  var API_BASE = 'https://www.jobswiper.ai'
  var MATCH_THRESHOLD = 45

  // ---- i18n (no framework; small inline table keyed off locale/navigator) ----
  var I18N = {
    en: {
      button: 'Autofill with JobSwiper',
      reviewTitle: 'Review before autofill',
      reviewSubtitle: 'JobSwiper fills only the fields you confirm.',
      confirm: function (n) { return 'Fill ' + n + (n === 1 ? ' field' : ' fields') },
      cancel: 'Cancel',
      filledToast: function (n) { return 'Filled ' + n + (n === 1 ? ' field' : ' fields') },
      nothingToast: 'No matching fields to fill here',
      completeTitle: 'Complete your profile',
      completeBody: 'Add your details on JobSwiper so we can autofill applications.',
      completeCta: 'Complete your profile',
      signInTitle: 'Sign in to JobSwiper',
      signInBody: 'Sign in on JobSwiper to autofill this application.',
      signInCta: 'Open JobSwiper',
      fields: {
        first_name: 'First name', last_name: 'Last name', full_name: 'Full name',
        email: 'Email', phone: 'Phone', city: 'City',
        linkedin_url: 'LinkedIn', website: 'Website',
      },
    },
    fr: {
      button: 'Remplir avec JobSwiper',
      reviewTitle: 'Vérifier avant le remplissage',
      reviewSubtitle: 'JobSwiper ne remplit que les champs que tu confirmes.',
      confirm: function (n) { return 'Remplir ' + n + (n === 1 ? ' champ' : ' champs') },
      cancel: 'Annuler',
      filledToast: function (n) { return n + (n === 1 ? ' champ rempli' : ' champs remplis') },
      nothingToast: 'Aucun champ correspondant à remplir ici',
      completeTitle: 'Complète ton profil',
      completeBody: 'Ajoute tes informations sur JobSwiper pour remplir tes candidatures automatiquement.',
      completeCta: 'Compléter mon profil',
      signInTitle: 'Connecte-toi à JobSwiper',
      signInBody: 'Connecte-toi sur JobSwiper pour remplir cette candidature.',
      signInCta: 'Ouvrir JobSwiper',
      fields: {
        first_name: 'Prénom', last_name: 'Nom', full_name: 'Nom complet',
        email: 'E-mail', phone: 'Téléphone', city: 'Ville',
        linkedin_url: 'LinkedIn', website: 'Site web',
      },
    },
  }

  function pickLang(locale) {
    var raw = locale
    if (!raw && isBrowser) raw = document.documentElement.lang || navigator.language
    raw = (raw || 'en').toLowerCase()
    return raw.indexOf('fr') === 0 ? 'fr' : 'en'
  }

  function t(lang) { return I18N[lang] || I18N.en }

  // ---- normalization ---------------------------------------------------------
  // Split camelCase, strip diacritics, lowercase, collapse to space-separated
  // tokens. So "firstName", "first_name", "Prénom" all normalize predictably.
  function normalize(s) {
    return (s == null ? '' : String(s))
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // Word-boundary containment over normalized (space-separated) text.
  function phraseInText(phrase, text) {
    if (!phrase || !text) return false
    return (' ' + text + ' ').indexOf(' ' + phrase + ' ') !== -1
  }

  // ---- field taxonomy --------------------------------------------------------
  // Only the 8 keys autofill v2 actually maps. github/headline are in the
  // profile payload but not mapped to inputs in v1 (ATS rarely expose them).
  // linkedin_url/website deliberately have NO generic autocomplete 'url' token:
  // it is too weak and would collide across both fields.
  var FIELD_MAP = [
    {
      key: 'first_name',
      autocomplete: ['given-name'],
      names: ['first name', 'firstname', 'given name', 'prenom'],
      labels: ['first name', 'given name', 'prenom', 'vorname', 'nombre'],
    },
    {
      key: 'last_name',
      autocomplete: ['family-name'],
      names: ['last name', 'lastname', 'surname', 'family name', 'nom'],
      labels: ['last name', 'surname', 'family name', 'nom de famille', 'nachname', 'apellido', 'apellidos'],
    },
    {
      key: 'full_name',
      autocomplete: ['name'],
      names: ['full name', 'fullname', 'name', 'your name'],
      labels: ['full name', 'name', 'your name', 'nom complet', 'vollstandiger name', 'nombre completo'],
    },
    {
      key: 'email',
      autocomplete: ['email'],
      names: ['email', 'e mail', 'courriel'],
      labels: ['email', 'email address', 'e mail', 'courriel', 'correo', 'correo electronico'],
    },
    {
      key: 'phone',
      autocomplete: ['tel', 'tel-national'],
      names: ['phone', 'telephone', 'mobile', 'tel', 'phone number'],
      labels: ['phone', 'phone number', 'telephone', 'mobile', 'portable', 'telefon', 'telefono', 'numero de telephone'],
    },
    {
      key: 'city',
      autocomplete: ['address-level2'],
      names: ['city', 'town', 'ville'],
      labels: ['city', 'town', 'ville', 'stadt', 'ciudad', 'localite'],
    },
    {
      key: 'linkedin_url',
      autocomplete: [],
      names: ['linkedin', 'linkedin url', 'linkedin profile'],
      labels: ['linkedin', 'linkedin url', 'linkedin profile', 'profil linkedin'],
    },
    {
      key: 'website',
      autocomplete: [],
      names: ['website', 'portfolio', 'personal website', 'personal site'],
      labels: ['website', 'portfolio', 'personal website', 'personal site', 'site web', 'site internet', 'sitio web', 'webseite'],
    },
  ]

  // ---- scoring ---------------------------------------------------------------
  // Score a field against one input's signals. Higher = stronger evidence.
  //   autocomplete token exact      = 100
  //   name/id exact whole value     = 85
  //   name/id contains field token  = 80
  //   label/aria exact phrase       = 70
  //   label/aria word-boundary hit  = 50
  //   placeholder word-boundary hit = 30
  function scoreFieldForSignals(field, sig) {
    var best = 0

    var ac = normalize(sig.autocomplete)
    if (ac && field.autocomplete && field.autocomplete.length) {
      for (var i = 0; i < field.autocomplete.length; i++) {
        if (normalize(field.autocomplete[i]) === ac) { best = Math.max(best, 100); break }
      }
    }

    var nameNorm = normalize((sig.name || '') + ' ' + (sig.id || ''))
    if (nameNorm && field.names) {
      for (var j = 0; j < field.names.length; j++) {
        var n = normalize(field.names[j])
        if (!n) continue
        if (nameNorm === n) best = Math.max(best, 85)
        else if (phraseInText(n, nameNorm)) best = Math.max(best, 80)
      }
    }

    var labelText = normalize((sig.aria || '') + ' ' + (sig.label || ''))
    if (labelText && field.labels) {
      for (var k = 0; k < field.labels.length; k++) {
        var l = normalize(field.labels[k])
        if (!l) continue
        if (labelText === l) best = Math.max(best, 70)
        else if (phraseInText(l, labelText)) best = Math.max(best, 50)
      }
    }

    var ph = normalize(sig.placeholder)
    if (ph && field.labels) {
      for (var m = 0; m < field.labels.length; m++) {
        var lp = normalize(field.labels[m])
        if (lp && phraseInText(lp, ph)) { best = Math.max(best, 30); break }
      }
    }

    return best
  }

  // Global greedy assignment: sort all (input, field, score) tuples by score
  // desc, assign so each input and each field is used at most once. This kills
  // the first-match collision where two name inputs both take full_name.
  function assignBestMatch(candidates, threshold) {
    var th = threshold == null ? MATCH_THRESHOLD : threshold
    var sorted = candidates
      .filter(function (c) { return c.score >= th })
      .sort(function (a, b) { return b.score - a.score })
    var usedInputs = new Set()
    var usedFields = new Set()
    var out = []
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i]
      if (usedInputs.has(c.inputRef) || usedFields.has(c.fieldKey)) continue
      usedInputs.add(c.inputRef)
      usedFields.add(c.fieldKey)
      out.push(c)
    }
    return out
  }

  // ---- denylist --------------------------------------------------------------
  // Prefer the shared denylist; fall back to an inline copy so autofill still
  // excludes sensitive fields even if apply-shared.js is not yet injected
  // (the manifest registration lands in Phase 3).
  var FALLBACK_DENYLIST = [
    'confirm', 'reference', 'emergency', 'manager', 'recruiter', 'previous employer',
    'spouse', 'work authorization', 'visa', 'sponsorship', 'citizenship', 'gender',
    'race', 'ethnicity', 'disability', 'veteran', 'eeo', 'salary expectation',
    'ssn', 'social security', 'date of birth',
  ]

  function denylist() {
    if (isBrowser && window.__jobswiperApply && window.__jobswiperApply.SENSITIVE_DENYLIST) {
      return window.__jobswiperApply.SENSITIVE_DENYLIST
    }
    return FALLBACK_DENYLIST
  }

  function labelIsSensitive(text) {
    var norm = normalize(text)
    if (!norm) return false
    var list = denylist()
    for (var i = 0; i < list.length; i++) {
      if (phraseInText(normalize(list[i]), norm)) return true
    }
    return false
  }

  // ===========================================================================
  // Browser-only DOM layer below. Everything above is pure and node-testable.
  // ===========================================================================
  if (isBrowser) {
    // Inputs the user has typed into (capture phase so we see it before fill).
    var dirtyInputs = new WeakSet()
    // Inputs we have already filled, so re-runs skip them.
    var filledInputs = new WeakSet()

    document.addEventListener('input', function (e) {
      if (e.isTrusted && e.target) dirtyInputs.add(e.target)
    }, true)

    function cssEscape(id) {
      if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(id)
      return String(id).replace(/["\\\]\[]/g, '\\$&')
    }

    function buildInputSignals(input) {
      var labelledby = ''
      var lb = input.getAttribute('aria-labelledby')
      if (lb) {
        labelledby = lb.split(/\s+/).map(function (id) {
          var el = document.getElementById(id)
          return el ? el.textContent : ''
        }).join(' ')
      }
      var forLabel = input.id ? document.querySelector('label[for="' + cssEscape(input.id) + '"]') : null
      var wrapLabel = input.closest ? input.closest('label') : null
      var fieldWrap = input.closest ? input.closest('[class*="field"]') : null
      var fieldLabel = fieldWrap ? fieldWrap.querySelector('label') : null
      var label = [
        forLabel ? forLabel.textContent : '',
        wrapLabel ? wrapLabel.textContent : '',
        fieldLabel ? fieldLabel.textContent : '',
      ].filter(Boolean).join(' ')
      return {
        autocomplete: input.getAttribute('autocomplete') || '',
        name: input.getAttribute('name') || '',
        id: input.id || '',
        aria: (input.getAttribute('aria-label') || '') + ' ' + labelledby,
        label: label,
        placeholder: input.getAttribute('placeholder') || '',
      }
    }

    // Build the confirmed assignment list: fillable, non-dirty, non-sensitive
    // inputs matched to a field with a non-empty profile value.
    function planFills(formRoot, profile) {
      var apply = window.__jobswiperApply
      if (!apply) return []
      var inputs = Array.prototype.slice.call(formRoot.querySelectorAll('input, textarea'))
      var candidates = []
      for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i]
        if (!apply.isFillableInput(input, formRoot)) continue
        if (dirtyInputs.has(input) || filledInputs.has(input)) continue
        var sig = buildInputSignals(input)
        var blob = [sig.autocomplete, sig.name, sig.id, sig.aria, sig.label, sig.placeholder].join(' ')
        // Hard exclude: a "confirm email" or "emergency phone" input must never
        // be filled even though email/phone mappings would otherwise match.
        if (labelIsSensitive(blob)) continue
        for (var f = 0; f < FIELD_MAP.length; f++) {
          var score = scoreFieldForSignals(FIELD_MAP[f], sig)
          if (score >= MATCH_THRESHOLD) {
            candidates.push({ input: input, inputRef: input, fieldKey: FIELD_MAP[f].key, score: score })
          }
        }
      }
      var assigned = assignBestMatch(candidates)
      var plan = []
      for (var a = 0; a < assigned.length; a++) {
        var value = profile ? profile[assigned[a].fieldKey] : ''
        if (value && String(value).trim() !== '') {
          plan.push({ input: assigned[a].input, fieldKey: assigned[a].fieldKey, value: String(value) })
        }
      }
      return plan
    }

    function fillInput(input, value) {
      var proto = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new Event('blur', { bubbles: true }))
      filledInputs.add(input)

      var prevOutline = input.style.outline
      var prevOffset = input.style.outlineOffset
      input.style.outline = '2px solid #1e4b8e'
      input.style.outlineOffset = '1px'
      setTimeout(function () {
        input.style.outline = prevOutline
        input.style.outlineOffset = prevOffset
      }, 2000)
    }

    function showToast(text) {
      var toast = document.createElement('div')
      toast.className = 'jobswiper-toast'
      toast.textContent = text
      document.body.appendChild(toast)
      setTimeout(function () { toast.remove() }, 3000)
    }

    // ---- closed-shadow overlay ----------------------------------------------
    // The consent surface renders inside attachShadow({ mode: 'closed' }) so
    // page-context JS cannot read the proposed profile values before confirm
    // (host.shadowRoot === null from the page).
    var PANEL_STYLE = [
      ':host { all: initial; }',
      '.wrap { position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;',
      '  width: 340px; max-width: calc(100vw - 32px); background: #ffffff;',
      '  border: 1px solid rgba(0,0,0,0.12); border-radius: 12px;',
      '  box-shadow: 0 8px 28px rgba(0,0,0,0.18);',
      '  font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  color: #111827; overflow: hidden; }',
      '.hd { padding: 14px 16px 10px; }',
      '.title { font-size: 15px; font-weight: 700; margin: 0 0 2px; }',
      '.sub { font-size: 12px; color: #6b7280; margin: 0; }',
      '.rows { max-height: 260px; overflow-y: auto; padding: 4px 16px; }',
      '.row { display: flex; justify-content: space-between; gap: 12px;',
      '  padding: 7px 0; border-top: 1px solid rgba(0,0,0,0.06); font-size: 13px; }',
      '.row:first-child { border-top: none; }',
      '.k { color: #6b7280; flex: 0 0 auto; }',
      '.v { color: #111827; font-weight: 600; text-align: right; overflow-wrap: anywhere; }',
      '.ft { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px 14px; }',
      '.btn { font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px;',
      '  border: 1px solid transparent; cursor: pointer; font-family: inherit; }',
      '.ghost { background: transparent; border-color: rgba(0,0,0,0.14); color: #374151; }',
      '.ghost:hover { background: rgba(0,0,0,0.05); }',
      '.primary { background: #1e4b8e; color: #ffffff; }',
      '.primary:hover { background: #163a6f; }',
      '.body { padding: 4px 16px 2px; font-size: 13px; color: #374151; }',
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
      host.className = 'jobswiper-autofill-host'
      var root = host.attachShadow({ mode: 'closed' })
      var style = document.createElement('style')
      style.textContent = PANEL_STYLE
      root.appendChild(style)
      var wrap = document.createElement('div')
      wrap.className = 'wrap'
      build(wrap)
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

    // Review-before-fill panel. Nothing is written until Confirm.
    function openReviewPanel(plan, lang) {
      var tr = t(lang)
      openPanel(function (wrap) {
        var hd = el('div', 'hd')
        hd.appendChild(el('p', 'title', tr.reviewTitle))
        hd.appendChild(el('p', 'sub', tr.reviewSubtitle))
        wrap.appendChild(hd)

        var rows = el('div', 'rows')
        for (var i = 0; i < plan.length; i++) {
          var row = el('div', 'row')
          row.appendChild(el('span', 'k', tr.fields[plan[i].fieldKey] || plan[i].fieldKey))
          row.appendChild(el('span', 'v', plan[i].value))
          rows.appendChild(row)
        }
        wrap.appendChild(rows)

        var ft = el('div', 'ft')
        var cancel = el('button', 'btn ghost', tr.cancel)
        cancel.addEventListener('click', closePanel)
        var confirm = el('button', 'btn primary', tr.confirm(plan.length))
        confirm.addEventListener('click', function () {
          closePanel()
          for (var j = 0; j < plan.length; j++) fillInput(plan[j].input, plan[j].value)
          showToast(tr.filledToast(plan.length))
        })
        ft.appendChild(cancel)
        ft.appendChild(confirm)
        wrap.appendChild(ft)
      })
    }

    // A deep-link panel (complete profile / sign in). No PII shown.
    function openLinkPanel(kind, lang) {
      var tr = t(lang)
      var title = kind === 'signin' ? tr.signInTitle : tr.completeTitle
      var bodyText = kind === 'signin' ? tr.signInBody : tr.completeBody
      var cta = kind === 'signin' ? tr.signInCta : tr.completeCta
      var href = kind === 'signin' ? (API_BASE + '/login') : (API_BASE + '/dashboard/profile')
      openPanel(function (wrap) {
        var hd = el('div', 'hd')
        hd.appendChild(el('p', 'title', title))
        wrap.appendChild(hd)
        wrap.appendChild(el('div', 'body', bodyText))
        var ft = el('div', 'ft')
        var cancel = el('button', 'btn ghost', tr.cancel)
        cancel.addEventListener('click', closePanel)
        var link = el('a', 'btn primary', cta)
        link.href = href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.addEventListener('click', closePanel)
        ft.appendChild(cancel)
        ft.appendChild(link)
        wrap.appendChild(ft)
      })
    }

    // ---- profile via the service worker (token never enters page context) ----
    function getProfile() {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, function (resp) {
            if (chrome.runtime.lastError) { resolve({ ok: false, error: 'sw' }); return }
            resolve(resp || { ok: false, error: 'empty' })
          })
        } catch (e) {
          resolve({ ok: false, error: 'throw' })
        }
      })
    }

    function isProfileUsable(profile) {
      return !!(profile && (
        (profile.full_name && String(profile.full_name).trim()) ||
        (profile.first_name && String(profile.first_name).trim())
      ))
    }

    var running = false
    function onButtonClick() {
      if (running) return
      running = true
      getProfile().then(function (resp) {
        running = false
        var lang = pickLang(resp && resp.locale)
        if (!resp || resp.ok === false) {
          openLinkPanel('signin', lang)
          return
        }
        var profile = resp.profile || {}
        if (!isProfileUsable(profile)) {
          openLinkPanel('complete', pickLang(resp.locale))
          return
        }
        var apply = window.__jobswiperApply
        var formRoot = apply ? apply.resolveFormRoot() : null
        if (!formRoot) { showToast(t(lang).nothingToast); return }
        var plan = planFills(formRoot, profile)
        if (!plan.length) { showToast(t(lang).nothingToast); return }
        openReviewPanel(plan, lang)
      })
    }

    // ---- button injection + SPA re-injection --------------------------------
    function injectButton() {
      if (document.querySelector('.jobswiper-autofill-btn')) return
      var apply = window.__jobswiperApply
      // apply-shared.js is registered in the manifest in Phase 3; degrade
      // silently (no button, no crash) until it is present.
      if (!apply) return
      if (!apply.resolveFormRoot()) return

      var lang = pickLang(null)
      var btn = document.createElement('button')
      btn.className = 'jobswiper-save-btn jobswiper-autofill-btn'
      btn.type = 'button'
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> '
      btn.appendChild(document.createTextNode(t(lang).button))
      btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483646;'
      btn.addEventListener('click', onButtonClick)
      document.body.appendChild(btn)
    }

    function removeButtonIfGone() {
      // If the application form disappeared (SPA route change), drop the button.
      var apply = window.__jobswiperApply
      if (!apply) return
      if (!apply.resolveFormRoot()) {
        var existing = document.querySelector('.jobswiper-autofill-btn')
        if (existing) existing.remove()
        closePanel()
      }
    }

    var debounceTimer = null
    function scheduleScan() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(function () {
        removeButtonIfGone()
        injectButton()
      }, 500)
    }

    var observer = null
    function startObserver() {
      if (observer || !document.body) return
      observer = new MutationObserver(scheduleScan)
      observer.observe(document.body, { childList: true, subtree: true })
    }

    // SPA route changes (Workday/Greenhouse) do not reload the page; hook
    // history so the button re-evaluates on navigation.
    function hookHistory() {
      var origPush = history.pushState
      history.pushState = function () {
        var ret = origPush.apply(this, arguments)
        scheduleScan()
        return ret
      }
      window.addEventListener('popstate', scheduleScan)
    }

    window.addEventListener('pagehide', function () {
      if (observer) { observer.disconnect(); observer = null }
      if (debounceTimer) clearTimeout(debounceTimer)
    })

    function boot() {
      injectButton()
      startObserver()
      hookHistory()
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 800) })
    } else {
      setTimeout(boot, 800)
    }
  }

  // node-only export channel for the pure scoring / denylist logic.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalize: normalize,
      phraseInText: phraseInText,
      scoreFieldForSignals: scoreFieldForSignals,
      assignBestMatch: assignBestMatch,
      labelIsSensitive: labelIsSensitive,
      FIELD_MAP: FIELD_MAP,
    }
  }
})()
