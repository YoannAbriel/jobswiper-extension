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
        current_company: 'Company', headline: 'Current title', github: 'GitHub',
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
        current_company: 'Entreprise', headline: 'Poste actuel', github: 'GitHub',
      },
    },
    es: {
      button: 'Autocompletar con JobSwiper',
      reviewTitle: 'Revisa antes de autocompletar',
      reviewSubtitle: 'JobSwiper solo rellena los campos que confirmes.',
      confirm: function (n) { return 'Rellenar ' + n + (n === 1 ? ' campo' : ' campos') },
      cancel: 'Cancelar',
      filledToast: function (n) { return n + (n === 1 ? ' campo rellenado' : ' campos rellenados') },
      nothingToast: 'No hay campos para rellenar aquí',
      completeTitle: 'Completa tu perfil',
      completeBody: 'Añade tus datos en JobSwiper para autocompletar tus candidaturas.',
      completeCta: 'Completar mi perfil',
      signInTitle: 'Inicia sesión en JobSwiper',
      signInBody: 'Inicia sesión en JobSwiper para autocompletar esta candidatura.',
      signInCta: 'Abrir JobSwiper',
      fields: {
        first_name: 'Nombre', last_name: 'Apellido', full_name: 'Nombre completo',
        email: 'Correo', phone: 'Teléfono', city: 'Ciudad',
        linkedin_url: 'LinkedIn', website: 'Sitio web',
        current_company: 'Empresa', headline: 'Puesto actual', github: 'GitHub',
      },
    },
  }

  function pickLang(locale) {
    var raw = locale
    if (!raw && isBrowser) raw = document.documentElement.lang || navigator.language
    raw = (raw || 'en').toLowerCase()
    return raw.indexOf('fr') === 0 ? 'fr' : raw.indexOf('es') === 0 ? 'es' : 'en'
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

  // Whitespace-normalize a candidate label and discard it (return '') when it is
  // too long to be a real label: a large fieldset legend or wrapper would
  // otherwise pollute every grouped field's signals with a block of body text.
  function boundedLabel(s) {
    var v = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim()
    return v.length > 60 ? '' : v
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
      names: ['city', 'town', 'ville', 'location', 'current location'],
      labels: ['city', 'town', 'ville', 'stadt', 'ciudad', 'localite', 'location', 'current location', 'localisation', 'ubicacion'],
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
    {
      key: 'current_company',
      autocomplete: ['organization'],
      names: ['company', 'current company', 'employer', 'current employer', 'org', 'organization'],
      labels: ['company', 'current company', 'employer', 'current employer', 'organization', 'entreprise', 'societe', 'empresa'],
    },
    {
      key: 'headline',
      autocomplete: ['organization-title'],
      names: ['headline', 'current title', 'current role', 'current position'],
      labels: ['headline', 'current title', 'current role', 'current position', 'titre actuel', 'poste actuel', 'puesto actual'],
    },
    {
      key: 'github',
      autocomplete: [],
      names: ['github', 'github url', 'github profile'],
      labels: ['github', 'github url', 'github profile', 'profil github'],
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
    // Kept in sync with apply-shared.js SENSITIVE_DENYLIST (reordered/plural forms).
    'authorized to work', 'eligible to work', 'right to work', 'work permit',
    'legally authorized', 'work eligibility', 'salary expectations', 'expected salary',
    'desired salary', 'current salary', 'salary requirement',
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
      // Fieldset legend acts as the group label for grouped inputs.
      var fs = input.closest ? input.closest('fieldset') : null
      var legendEl = fs ? fs.querySelector('legend') : null
      // Pseudo-label fallback: many ATS (Greenhouse, Workday, ...) render the
      // label as a div/span with a "label"-ish class instead of a real <label>.
      // Only consulted when no semantic label was found, and bounded to a short
      // string so we never absorb a block of body text as the label.
      var pseudo = ''
      if (!forLabel && !wrapLabel && !fieldLabel && !labelledby) {
        var pWrap = input.closest
          ? input.closest('[class*="field" i], [class*="form-group" i], [class*="form-row" i], [class*="input" i]')
          : null
        var pl = pWrap ? pWrap.querySelector('[class*="label" i]') : null
        if (pl && pl.tagName !== 'LABEL') pseudo = pl.textContent || ''
        if (!pseudo) {
          var prev = input.previousElementSibling
          if (prev && (prev.tagName === 'DIV' || prev.tagName === 'SPAN' || prev.tagName === 'P')) {
            pseudo = prev.textContent || ''
          }
        }
        pseudo = boundedLabel(pseudo)
      }
      var label = [
        forLabel ? forLabel.textContent : '',
        wrapLabel ? wrapLabel.textContent : '',
        fieldLabel ? fieldLabel.textContent : '',
        boundedLabel(legendEl ? legendEl.textContent : ''),
        pseudo,
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
      filledInputs.add(input)

      // Autocomplete / combobox fields (Lever & Greenhouse location typeaheads,
      // etc.) drop a bare text value on blur unless an option is picked, which is
      // what sets their hidden value. Try to select the matching option; blur is
      // deferred to trySelectComboboxOption so the dropdown has time to render.
      if (isComboboxInput(input)) {
        trySelectComboboxOption(input, value)
      } else {
        input.dispatchEvent(new Event('blur', { bubbles: true }))
      }

      highlightFilled(input)
    }

    function highlightFilled(input) {
      var prevOutline = input.style.outline
      var prevOffset = input.style.outlineOffset
      input.style.outline = '2px solid #0064be'
      input.style.outlineOffset = '1px'
      setTimeout(function () {
        input.style.outline = prevOutline
        input.style.outlineOffset = prevOffset
      }, 2000)
    }

    // A text input that drives a typeahead: has ARIA combobox wiring, or is
    // paired with a hidden "selected..." field the way Lever/Greenhouse encode
    // the resolved choice.
    function isComboboxInput(input) {
      if (!input || input.tagName !== 'INPUT') return false
      var type = (input.getAttribute('type') || 'text').toLowerCase()
      if (type !== 'text' && type !== 'search') return false
      var role = (input.getAttribute('role') || '').toLowerCase()
      if (role === 'combobox') return true
      if (input.getAttribute('aria-autocomplete')) return true
      if (input.getAttribute('aria-controls') || input.getAttribute('aria-owns')) return true
      if (input.getAttribute('aria-expanded') !== null) return true
      var form = input.form || (input.closest && input.closest('form')) || document
      var nm = input.getAttribute('name') || ''
      if (nm) {
        var cap = nm.charAt(0).toUpperCase() + nm.slice(1)
        if (form.querySelector('input[type="hidden"][name="selected' + cap + '"]')) return true
      }
      if (input.id) {
        var base = input.id.replace(/-input$/, '')
        if (form.querySelector('input[type="hidden"][id="selected-' + base + '"]')) return true
      }
      return false
    }

    function findVisibleOptions(input) {
      var owns = input.getAttribute('aria-controls') || input.getAttribute('aria-owns')
      var scope = null
      if (owns) scope = document.getElementById(owns)
      scope = scope || document
      var sels = '[role="option"], [role="listbox"] li, .dropdown-location li, ' +
        '[class*="dropdown"] li, [class*="autocomplete"] li, [class*="typeahead"] li, ' +
        '[class*="results"] li, [class*="suggestion"] li'
      var nodes = Array.prototype.slice.call(scope.querySelectorAll(sels))
      return nodes.filter(function (n) {
        return n.offsetParent !== null && (n.textContent || '').trim().length > 0
      })
    }

    // Only click an option that actually shares the wanted value's leading token
    // (e.g. the city name), so we never pick an unrelated first row.
    function pickBestOption(options, want, wantFirst) {
      var starts = null, contains = null
      for (var i = 0; i < options.length; i++) {
        var txt = normalize(options[i].textContent || '')
        if (!txt) continue
        if (txt === want) return options[i]
        if (!starts && (txt.indexOf(want) === 0 || (wantFirst && txt.indexOf(wantFirst) === 0))) starts = options[i]
        if (!contains && wantFirst && txt.indexOf(wantFirst) !== -1) contains = options[i]
      }
      return starts || contains || null
    }

    function trySelectComboboxOption(input, value) {
      try {
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }))
      } catch (e) {}
      var want = normalize(value)
      var wantFirst = want.split(' ')[0] || want
      var tries = 0
      var poll = setInterval(function () {
        tries++
        if (!chrome.runtime || !chrome.runtime.id) { clearInterval(poll); return }
        var options = findVisibleOptions(input)
        if (options.length) {
          var pick = pickBestOption(options, want, wantFirst)
          if (pick) {
            pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            pick.click()
          }
          clearInterval(poll)
          setTimeout(function () { try { input.dispatchEvent(new Event('blur', { bubbles: true })) } catch (e) {} }, 60)
          return
        }
        if (tries >= 8) { // ~1.2s: typeahead never showed options, keep the text
          clearInterval(poll)
          try { input.dispatchEvent(new Event('blur', { bubbles: true })) } catch (e) {}
        }
      }, 150)
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

    // =========================================================================
    // Bus-driven surface (sidebar). The sidebar (content/sidebar.js, loaded LAST
    // in the manifest apply block) is now the primary surface: it subscribes to
    // window.__jobswiperApply events and calls startFill/stopFill/selectCv. This
    // script no longer renders its own bottom-right button or the closed-shadow
    // review panel; both are superseded by the sidebar feed. The old panel code
    // above is kept intact (code path preserved) but is never shown while the
    // sidebar owns the surface, so there is never a double Fill UI.
    // =========================================================================

    // apply-shared.js initializes the bus on the SAME window.__jobswiperApply
    // object and is listed FIRST in the manifest, so emit is normally present.
    // Guard with a no-op fallback in case this script somehow loads first.
    function busEmit(evt, data) {
      var apply = window.__jobswiperApply
      if (apply && typeof apply.emit === 'function') apply.emit(evt, data)
    }

    // ---- context (active CV + profile) via the service worker ----------------
    // getProfile() already lives above (GET_PROFILE). getCvs() mirrors it for
    // GET_CVS. Both keep the auth token in the SW; the content script only ever
    // receives ids/titles and non-sensitive profile fields.
    function getCvs() {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({ type: 'GET_CVS', likedJobId: null }, function (resp) {
            if (chrome.runtime.lastError) { resolve({ ok: false }); return }
            resolve(resp || { ok: false })
          })
        } catch (e) {
          resolve({ ok: false })
        }
      })
    }

    var ctxProfileResp = null
    var ctxCvsResp = null
    var ctxPromise = null
    var ctxSig = ''
    var ctxFailAt = 0
    var CTX_FAIL_TTL_MS = 20000

    // Fetch the profile + CV context once, cache it, and emit 'ctx'. A failed
    // fetch (signed out / offline) is cached only briefly so a later scan can
    // recover after the user signs in, without hammering the SW on every scan.
    function ensureCtx(force) {
      var now = Date.now()
      if (force) { ctxProfileResp = null; ctxCvsResp = null; ctxPromise = null; ctxFailAt = 0 }
      if (ctxProfileResp && ctxProfileResp.ok !== false) return Promise.resolve(ctxProfileResp)
      if (ctxProfileResp && ctxProfileResp.ok === false && (now - ctxFailAt) < CTX_FAIL_TTL_MS) {
        return Promise.resolve(ctxProfileResp)
      }
      if (ctxPromise) return ctxPromise
      ctxPromise = getProfile().then(function (presp) {
        ctxProfileResp = presp || { ok: false }
        if (ctxProfileResp.ok === false) ctxFailAt = Date.now()
        return getCvs().then(function (cresp) {
          ctxCvsResp = cresp || { ok: false }
          ctxPromise = null
          emitCtx()
          return ctxProfileResp
        }, function () {
          ctxCvsResp = { ok: false }
          ctxPromise = null
          emitCtx()
          return ctxProfileResp
        })
      }, function () {
        ctxProfileResp = { ok: false }
        ctxFailAt = Date.now()
        ctxPromise = null
        emitCtx()
        return ctxProfileResp
      })
      return ctxPromise
    }

    function profileNameOf(profile) {
      if (!profile) return null
      var full = profile.full_name && String(profile.full_name).trim()
      if (full) return full
      var parts = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
      return parts || null
    }

    // Resolve the active CV (recorded selection, else per-job default, else the
    // first listed) into the { name, tailored, jobLabel } shape the sidebar wants.
    function activeCvOf(cvsResp) {
      if (!cvsResp || cvsResp.ok === false) return null
      var list = Array.isArray(cvsResp.cvs) ? cvsResp.cvs : []
      if (!list.length) return null
      var activeId = cvsResp.selectedCvId || cvsResp.defaultCvId || list[0].id
      var active = null
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === activeId) { active = list[i]; break }
      }
      active = active || list[0]
      return {
        name: active.title || null,
        tailored: !!active.isPerJob,
        jobLabel: (cvsResp.jobCv && cvsResp.jobCv.title) || null,
      }
    }

    // Emit 'ctx' only when it actually changed, so repeated scans do not spam it.
    function emitCtx() {
      var profile = (ctxProfileResp && ctxProfileResp.profile) || null
      var payload = {
        cv: activeCvOf(ctxCvsResp),
        profileName: profileNameOf(profile),
        signedIn: !!(ctxProfileResp && ctxProfileResp.ok !== false),
      }
      var cv = payload.cv
      var sig = (payload.profileName || 'none') + '|' + payload.signedIn + '|' +
        (cv ? (cv.name + '/' + cv.tailored + '/' + cv.jobLabel) : 'none')
      if (sig === ctxSig) return
      ctxSig = sig
      busEmit('ctx', payload)
    }

    // ---- skipped fields (for the sidebar review feed) ------------------------
    // The plan (planFills) is authoritative for what WILL be filled; this derives
    // the parallel "won't fill" list without touching planFills. Sensitive fields
    // are those the shared denylist excludes; 'required' flags a required input we
    // could not map to a profile value, so the user knows to complete it by hand.
    function firstLine(s) {
      if (!s) return ''
      return String(s).split('\n')[0].replace(/\s+/g, ' ').trim()
    }

    function readableLabel(sig) {
      var cand = firstLine(sig.label) || firstLine(sig.aria) ||
        firstLine(sig.placeholder) || firstLine(sig.name) || firstLine(sig.id)
      cand = cand.replace(/[*:\s]+$/, '').trim()
      if (cand.length > 60) cand = cand.slice(0, 57) + '...'
      return cand || 'Field'
    }

    function isRequiredInput(input) {
      if (!input) return false
      if (input.required) return true
      return input.getAttribute && input.getAttribute('aria-required') === 'true'
    }

    function computeSkipped(formRoot, plan) {
      var apply = window.__jobswiperApply
      if (!apply || !formRoot) return []
      var plannedInputs = new Set()
      for (var p = 0; p < plan.length; p++) plannedInputs.add(plan[p].input)
      var inputs = Array.prototype.slice.call(formRoot.querySelectorAll('input, textarea'))
      var out = []
      var seen = Object.create(null)
      for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i]
        if (!apply.isFillableInput(input, formRoot)) continue
        if (dirtyInputs.has(input) || filledInputs.has(input)) continue
        var sig = buildInputSignals(input)
        var blob = [sig.autocomplete, sig.name, sig.id, sig.aria, sig.label, sig.placeholder].join(' ')
        var reason = null
        if (labelIsSensitive(blob)) reason = 'sensitive'
        else if (isRequiredInput(input) && !plannedInputs.has(input)) reason = 'required'
        if (!reason) continue
        var label = readableLabel(sig)
        var key = reason + '|' + normalize(label)
        if (seen[key]) continue
        seen[key] = true
        // Carry the live input ref (same-window bus, never serialized) so the
        // sidebar can offer a jump-to-field affordance on required fields.
        out.push({ label: label, reason: reason, input: input })
      }
      return out
    }

    // A cover-letter textarea: labelled as a cover letter / motivation letter.
    // These get the CL generator, not the screening-answer drafter, so they are
    // excluded from computeQuestions and surfaced separately.
    // "motivation letter" / "lettre de motivation", not a bare "motivation" (which
    // would grab a "what motivates you" short-answer question, not a CL field).
    var CL_LABEL_RE = /cover\s*letter|lettre de motivation|motivation letter|anschreiben|carta de presentaci/i

    function isCoverLetterSig(sig) {
      var blob = [sig.name, sig.id, sig.aria, sig.label, sig.placeholder].join(' ')
      return CL_LABEL_RE.test(blob)
    }

    // The cover-letter textarea on the form (fillable, empty), if any.
    function findCoverLetterField(formRoot) {
      var apply = window.__jobswiperApply
      if (!apply || !formRoot) return null
      var areas = Array.prototype.slice.call(formRoot.querySelectorAll('textarea'))
      for (var i = 0; i < areas.length; i++) {
        var input = areas[i]
        if (!apply.isFillableInput(input, formRoot)) continue
        if (dirtyInputs.has(input) || filledInputs.has(input)) continue
        var sig = buildInputSignals(input)
        if (isCoverLetterSig(sig)) return { input: input, label: readableLabel(sig) }
      }
      return null
    }

    // Best-effort job context scraped from the current apply page for the cover
    // letter. Bounded and honest: whatever is not found is simply omitted.
    function scrapeJobContext() {
      var ctx = {}
      try {
        var h1 = document.querySelector('h1')
        var title = (h1 && h1.textContent) || document.title || ''
        title = title.replace(/\s+/g, ' ').trim()
        if (title) ctx.jobTitle = title.slice(0, 200)
      } catch (e) {}
      try {
        var ogSite = document.querySelector('meta[property="og:site_name"]')
        var company = (ogSite && ogSite.getAttribute('content')) || ''
        if (!company) {
          var host = (location.hostname || '').replace(/^www\./, '').split('.')[0]
          company = host || ''
        }
        if (company) ctx.company = company.slice(0, 120)
      } catch (e) {}
      try {
        var descEl = document.querySelector('[class*="description" i], [class*="job-details" i], article, main')
        var desc = (descEl && descEl.textContent) || ''
        desc = desc.replace(/\s+/g, ' ').trim()
        if (desc.length > 120) ctx.jobDescription = desc.slice(0, 5000)
      } catch (e) {}
      return ctx
    }

    // Generate a cover letter from the scraped job context + the profile (server
    // side), then insert it into the detected CL textarea. Click-only, grounded,
    // never auto-submitted; narrated via 'coverletter'. Same-frame only.
    function generateCoverLetter() {
      var apply = window.__jobswiperApply
      var root = apply ? apply.resolveFormRoot() : null
      var field = root ? findCoverLetterField(root) : null
      if (!field || !field.input) { busEmit('coverletter', { status: 'nofield' }); return }
      busEmit('coverletter', { status: 'generating' })
      var msg = scrapeJobContext()
      msg.type = 'GENERATE_COVER_LETTER'
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) { busEmit('coverletter', { status: 'error' }); return }
          if (resp && resp.limitType) { busEmit('coverletter', { status: 'limit' }); return }
          if (!resp || resp.success === false || !resp.coverLetter) {
            busEmit('coverletter', { status: 'error' })
            return
          }
          try { fillInput(field.input, String(resp.coverLetter)) } catch (e) {}
          busEmit('coverletter', { status: 'done' })
        })
      } catch (e) {
        busEmit('coverletter', { status: 'error' })
      }
    }

    // ---- free-text screening questions (for the sidebar AI-draft feature) ----
    // A textarea the user has NOT typed in, that is not sensitive and is not one
    // of our mapped profile fields, with a readable label = a screening question
    // the user can ask JobSwiper to draft an honest answer for. We never touch
    // these automatically; the sidebar offers an explicit per-question button.
    function computeQuestions(formRoot) {
      var apply = window.__jobswiperApply
      if (!apply || !formRoot) return []
      var areas = Array.prototype.slice.call(formRoot.querySelectorAll('textarea'))
      var out = []
      var seen = Object.create(null)
      for (var i = 0; i < areas.length && out.length < 8; i++) {
        var input = areas[i]
        if (!apply.isFillableInput(input, formRoot)) continue
        if (dirtyInputs.has(input) || filledInputs.has(input)) continue
        var sig = buildInputSignals(input)
        var blob = [sig.autocomplete, sig.name, sig.id, sig.aria, sig.label, sig.placeholder].join(' ')
        if (labelIsSensitive(blob)) continue
        // A cover-letter textarea belongs to the CL generator, not here.
        if (isCoverLetterSig(sig)) continue
        // Skip a textarea that is actually one of our mapped profile fields.
        var mapped = false
        for (var f = 0; f < FIELD_MAP.length; f++) {
          if (scoreFieldForSignals(FIELD_MAP[f], sig) >= MATCH_THRESHOLD) { mapped = true; break }
        }
        if (mapped) continue
        var label = readableLabel(sig)
        if (!label || label === 'Field') continue
        var key = normalize(label)
        if (seen[key]) continue
        seen[key] = true
        out.push({ input: input, label: label })
      }
      return out
    }

    // Draft an answer for question index, insert it, and narrate via 'answer'.
    // The SW route grounds on the profile and forbids fabrication; nothing is
    // auto-submitted. Same-frame only (the input ref does not cross the bridge).
    function draftAnswer(index) {
      var q = lastQuestions[index]
      if (!q || !q.input) return
      // Carry the label (not just the index): a redetect can rebuild the sidebar
      // rows, so the completion must be matched by a stable id, not array slot.
      var label = q.label
      busEmit('answer', { index: index, label: label, status: 'drafting' })
      try {
        chrome.runtime.sendMessage({ type: 'ANSWER_QUESTION', question: q.label }, function (resp) {
          if (chrome.runtime.lastError) { busEmit('answer', { index: index, label: label, status: 'error' }); return }
          // A real quota cap (lifetime/daily/monthly) carries limitType; show it
          // as a limit, not a generic failure (a transient 503 has no limitType).
          if (resp && resp.limitType) { busEmit('answer', { index: index, label: label, status: 'limit' }); return }
          if (!resp || resp.success === false || !resp.answer) {
            busEmit('answer', { index: index, label: label, status: 'error' })
            return
          }
          try { fillInput(q.input, String(resp.answer)) } catch (e) {}
          busEmit('answer', { index: index, label: label, status: 'done' })
        })
      } catch (e) {
        busEmit('answer', { index: index, label: label, status: 'error' })
      }
    }

    function fieldLabel(key, lang) {
      var tr = t(lang)
      return (tr.fields && tr.fields[key]) || key
    }

    function planToFields(plan, lang) {
      return plan.map(function (p) {
        return { key: p.fieldKey, label: fieldLabel(p.fieldKey, lang), value: p.value }
      })
    }

    function planSignature(fields, skipped, questions, cl) {
      var a = fields.map(function (f) { return f.key + '=' + f.value }).join('|')
      var b = skipped.map(function (s) { return s.reason + ':' + s.label }).join('|')
      var c = (questions || []).map(function (q) { return q.label }).join('|')
      var d = cl ? cl.label : ''
      return a + '||' + b + '||' + c + '||' + d
    }

    // ---- detection lifecycle -------------------------------------------------
    // detectState: 'idle' | 'detecting' | 'ready' | 'empty' | 'error:signin' |
    // 'error:complete'. It gates re-emits so a busy MutationObserver does not
    // spam the sidebar feed.
    var detectState = 'idle'
    var detectInFlight = false
    var lastPlan = []
    var lastQuestions = []  // free-text screening questions detected this pass (with input refs)
    var lastPlanSig = ''

    function emitEmpty() {
      if (detectState === 'empty') return
      detectState = 'empty'
      lastPlan = []
      lastPlanSig = ''
      busEmit('empty')
    }

    function emitAuthError(kind, lang) {
      var tr = t(lang)
      var msg = kind === 'signin' ? tr.signInBody : tr.completeBody
      var href = kind === 'signin' ? (API_BASE + '/login') : (API_BASE + '/dashboard/profile')
      var stateKey = 'error:' + kind
      if (detectState === stateKey) return
      detectState = stateKey
      lastPlanSig = ''
      busEmit('error', { message: msg, kind: kind, href: href })
    }

    function finishDetect(presp) {
      var apply = window.__jobswiperApply
      // Re-resolve the root: the DOM may have changed during the async ctx fetch.
      var root = apply ? apply.resolveFormRoot() : null
      if (!root) { emitEmpty(); return }
      var lang = pickLang(presp && presp.locale)
      if (!presp || presp.ok === false) { emitAuthError('signin', lang); return }
      var profile = presp.profile || {}
      if (!isProfileUsable(profile)) { emitAuthError('complete', lang); return }
      var plan = planFills(root, profile)
      var skipped = computeSkipped(root, plan)
      var questions = computeQuestions(root)
      var clField = findCoverLetterField(root)
      var fields = planToFields(plan, lang)
      var sig = planSignature(fields, skipped, questions, clField)
      if (sig === lastPlanSig && detectState === 'ready') return
      lastPlan = plan
      lastQuestions = questions
      lastPlanSig = sig
      detectState = 'ready'
      busEmit('ready', {
        fields: fields,
        skipped: skipped,
        questions: questions.map(function (q) { return { label: q.label } }),
        coverLetter: clField ? { label: clField.label } : null,
      })
    }

    function runDetect() {
      var apply = window.__jobswiperApply
      // Broad injection gate: on a non-job page this is the cheap early-out that
      // keeps the whole detect path (root resolution, ctx fetch, emits) dark.
      if (apply && apply.isLikelyJobApplication && !apply.isLikelyJobApplication()) return
      var root = apply ? apply.resolveFormRoot() : null
      if (!root) { emitEmpty(); return }
      if (detectInFlight) return
      detectInFlight = true
      if (detectState === 'idle' || detectState === 'empty') {
        detectState = 'detecting'
        busEmit('detecting')
      }
      ensureCtx().then(function (presp) {
        try { finishDetect(presp) } finally { detectInFlight = false }
      }, function () { detectInFlight = false })
    }

    // ---- fill lifecycle (commands: startFill / stopFill) ---------------------
    // startFill drives EXACTLY the existing planFills + fillInput path. The plan
    // is re-resolved against the live DOM so it reflects anything the user typed
    // since detection. Filling is staggered so the sidebar can show progress and
    // so combobox typeaheads have room to resolve; stopFill aborts in flight.
    var filling = false
    var fillAbort = false
    var fillTimer = null
    var fillPlan = []
    var fillIndex = 0
    var fillTotal = 0
    var fillSkipped = []
    var fillLang = 'en'

    // Post-fill verification: re-read an input and report whether the value
    // failed to land. Combobox/typeahead inputs resolve asynchronously and often
    // hold the option label rather than the raw value, so they are never flagged.
    // The check is deliberately lenient (empty == failed) so an input that merely
    // reformats what we set (phone masks, date pickers) is not a false positive.
    function readbackFailed(item) {
      try {
        if (!item || !item.input) return false
        if (isComboboxInput(item.input)) return false
        var v = String(item.input.value == null ? '' : item.input.value).trim()
        return v === ''
      } catch (e) { return false }
    }

    // Runs a beat after the last fill so framework-controlled inputs (React/Vue)
    // have a tick to keep or revert what we set. Reports the CONFIRMED filled
    // count, not the attempted count, and routes any value that did not stick into
    // the skipped list so the sidebar shows the honest state instead of a false
    // "N fields filled".
    function finalizeFill() {
      fillTimer = null
      filling = false
      // stopFill may have aborted during the deferred window; honor it (stopFill
      // already emitted its own done).
      if (fillAbort) return
      var ok = 0
      var unfilled = []
      for (var i = 0; i < fillPlan.length; i++) {
        if (readbackFailed(fillPlan[i])) {
          unfilled.push({ label: fieldLabel(fillPlan[i].fieldKey, fillLang), reason: 'required', input: fillPlan[i].input })
        } else { ok++ }
      }
      var skippedCount = (fillSkipped ? fillSkipped.length : 0) + unfilled.length
      busEmit('filled', { count: ok })
      busEmit('done', { filled: ok, total: fillTotal, skipped: skippedCount, unfilled: unfilled })
      try { showToast(t(fillLang).filledToast(ok)) } catch (e) {}
    }

    function fillStep() {
      if (fillAbort) return
      if (fillIndex >= fillTotal) {
        // Keep `filling` true across the deferred window so stopFill() can still
        // abort; finalizeFill flips it false when it actually runs.
        fillTimer = setTimeout(finalizeFill, 300)
        return
      }
      var item = fillPlan[fillIndex]
      try {
        fillInput(item.input, item.value)
      } catch (e) {
        // A single field throwing must not flash the full error card mid-fill.
        // finalizeFill re-reads every field and routes any that did not land into
        // the needs-you list, so a per-field failure degrades to a partial result
        // instead of aborting the whole run with a scary error.
      }
      fillIndex++
      busEmit('progress', {
        index: fillIndex,
        total: fillTotal,
        field: { key: item.fieldKey, label: fieldLabel(item.fieldKey, fillLang) },
      })
      fillTimer = setTimeout(fillStep, 140)
    }

    function runFill(plan, skipped, lang) {
      filling = true
      fillAbort = false
      fillPlan = plan
      fillIndex = 0
      fillTotal = plan.length
      fillSkipped = skipped
      fillLang = lang
      fillStep()
    }

    function startFill() {
      if (filling) return
      var apply = window.__jobswiperApply
      var root = apply ? apply.resolveFormRoot() : null
      if (!root) { emitEmpty(); return }
      ensureCtx().then(function (presp) {
        var lang = pickLang(presp && presp.locale)
        if (!presp || presp.ok === false) { emitAuthError('signin', lang); return }
        var profile = presp.profile || {}
        if (!isProfileUsable(profile)) { emitAuthError('complete', lang); return }
        var plan = planFills(root, profile)
        var skipped = computeSkipped(root, plan)
        if (!plan.length) {
          busEmit('done', { filled: 0, total: 0, skipped: skipped.length })
          return
        }
        runFill(plan, skipped, lang)
      })
    }

    function stopFill() {
      if (!filling) return
      fillAbort = true
      if (fillTimer) { clearTimeout(fillTimer); fillTimer = null }
      filling = false
      busEmit('done', { filled: fillIndex, total: fillTotal, skipped: fillSkipped ? fillSkipped.length : 0 })
    }

    // ---- selectCv command ----------------------------------------------------
    // Persist the chosen CV via the SW (no-op server-side without a likedJobId,
    // which a raw ATS page has none of), then force-refresh + re-emit ctx so the
    // sidebar reflects the new active CV.
    function selectCv(cvId) {
      return new Promise(function (resolve) {
        try {
          chrome.runtime.sendMessage({ type: 'SELECT_CV', likedJobId: null, cvId: cvId }, function () {
            void chrome.runtime.lastError
            ensureCtx(true).then(function () { resolve(true) }, function () { resolve(false) })
          })
        } catch (e) {
          resolve(false)
        }
      })
    }

    // Attach the commands to the shared object synchronously (before sidebar.js,
    // which is loaded after this script, runs) so the sidebar finds them on init.
    function exposeCommands() {
      var apply = window.__jobswiperApply
      if (!apply) return
      apply.startFill = startFill
      apply.stopFill = stopFill
      apply.selectCv = selectCv
      apply.draftAnswer = draftAnswer
      apply.generateCoverLetter = generateCoverLetter
    }
    exposeCommands()

    // ---- scan scheduling + SPA re-detection ----------------------------------
    var debounceTimer = null
    function scheduleScan() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(runDetect, 500)
    }

    var observer = null
    function startObserver() {
      if (observer || !document.body) return
      observer = new MutationObserver(scheduleScan)
      observer.observe(document.body, { childList: true, subtree: true })
    }

    // SPA route changes (Workday/Greenhouse) do not reload the page; hook history
    // so detection re-evaluates on navigation. Hooking history is cheap (no
    // observer, no timer) so it is safe to arm even on a non-job page: it is how
    // a broad-injected SPA that later routes INTO an application gets picked up.
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

    // On navigation: if the apply layer is already armed just re-scan; otherwise
    // re-evaluate the gate and arm it only if the new URL/DOM is an application.
    function onNav() {
      if (observer) { scheduleScan(); return }
      armIfLikely()
    }

    function armIfLikely() {
      var apply = window.__jobswiperApply
      if (apply && apply.isLikelyJobApplication && !apply.isLikelyJobApplication()) {
        // LinkedIn Easy Apply opens as a modal with no URL change, so the gate is
        // false at boot. Arm the observer anyway on LinkedIn job pages so we catch
        // the modal when it opens; runDetect re-checks the gate on each debounced
        // mutation and stays a no-op until the apply form actually appears.
        // Everywhere else, stay fully inert until the page looks like an apply.
        if (apply.isLinkedInJobPage && apply.isLinkedInJobPage()) startObserver()
        return
      }
      runDetect()
      startObserver()
    }

    window.addEventListener('pagehide', function () {
      if (observer) { observer.disconnect(); observer = null }
      if (debounceTimer) clearTimeout(debounceTimer)
      if (fillTimer) { clearTimeout(fillTimer); fillTimer = null }
    })

    // boot(): always hook history (cheap SPA-nav listener), but only arm the
    // MutationObserver + run the detect loop when this actually looks like a job
    // application. On a plain page nothing observes, fetches, or times.
    function boot() {
      hookHistory()
      armIfLikely()
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
