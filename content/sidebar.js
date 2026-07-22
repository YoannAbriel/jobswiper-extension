/**
 * JobSwiper - Apply sidebar (Shadow-DOM primary surface).
 *
 * Injected ONCE into the ATS host page. It is the primary surface for the apply
 * flow: it renders the live autofill state machine (detect -> match -> fill ->
 * attach -> submit), a transparency feed, and four secondary views (CVs,
 * Activité, Profil, Plan). It NEVER touches the form itself and NEVER fetches:
 *
 *   - Form logic (planFills / fillInput / combobox / SENSITIVE_DENYLIST / field
 *     detection) lives in content/autofill.js and is not touched here.
 *   - Authenticated fetches (profile, cvs, stats, cv pdf) live in the service
 *     worker; this script only sends messages and renders the responses.
 *
 * Wiring (INTEGRATION CONTRACT):
 *   - Subscribes to the shared bus on window.__jobswiperApply:
 *       ctx / detecting / ready / empty / progress / filled / attach / done / error
 *   - Drives the flow via the shared commands:
 *       startFill() / stopFill() / attachCv() / selectCv(id)
 *   - apply-shared.js initializes the bus (loaded first). If this script loads
 *     first, it retries binding until on/emit exist (bounded), and guards with a
 *     no-op fallback so it never throws.
 *
 * There is NO double UI: this sidebar is the primary surface. The old
 * bottom-right button and closed-shadow review panel in autofill.js are
 * superseded (autofill hides them when the sidebar is present).
 */
;(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__jobswiperSidebarLoaded) return
  window.__jobswiperSidebarLoaded = true

  var API_BASE = 'https://www.jobswiper.ai'
  var HOST_ID = 'jobswiper-apply-sidebar-host'

  // ---- chrome guards ---------------------------------------------------------
  function hasRuntime() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id) } catch (e) { return false }
  }
  function send(msg, cb) {
    if (!hasRuntime()) { if (cb) cb(null); return }
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        // Swallow "receiving end does not exist" and context-invalidated errors.
        var err = chrome.runtime && chrome.runtime.lastError
        if (err) { if (cb) cb(null); return }
        if (cb) cb(resp || null)
      })
    } catch (e) { if (cb) cb(null) }
  }
  function storageGet(key, cb) {
    if (!hasRuntime() || !chrome.storage || !chrome.storage.local) { cb(null); return }
    try { chrome.storage.local.get(key, function (o) { cb(o || null) }) } catch (e) { cb(null) }
  }
  function storageSet(obj) {
    if (!hasRuntime() || !chrome.storage || !chrome.storage.local) return
    try { chrome.storage.local.set(obj) } catch (e) { /* noop */ }
  }
  // Real extension icon URL (web_accessible_resources). Guarded so it never
  // throws in a context where chrome.runtime.getURL is unavailable.
  function logoUrl() {
    try {
      if (chrome && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL('icons/icon128.png')
    } catch (e) { /* noop */ }
    return ''
  }

  // ---- i18n (inline table, same pickLang pattern as autofill.js/cv-attach.js) -
  var I18N = {
    en: {
      collapse: 'Collapse',
      state: { detecting: 'Analyzing…', ready: 'Ready', filling: 'Filling', done: 'Done', empty: 'No form', error: 'Error' },
      nav: { apply: 'Apply', cvs: 'CV', activity: 'Activity', profile: 'Profile', plan: 'Plan' },
      applyWith: 'Applying with',
      cvTailored: 'TAILORED CV', cvBase: 'BASE CV',
      tailoredFor: 'Tailored to this offer', genericCv: 'Generic CV',
      change: 'Change',
      detected: function (n) { return n + (n === 1 ? ' field detected' : ' fields detected') },
      formRecognized: 'Application form recognized',
      profileMatched: 'Profile matched',
      profileMatchedSub: 'Your details + the tailored CV',
      fillStep: 'Filling the fields',
      filledStep: function (n) { return n + (n === 1 ? ' field filled' : ' fields filled') },
      attachStep: 'Attach the CV',
      submitStep: 'Ready to submit',
      submitSub: 'Submitting stays yours',
      filling: function (i, n) { return 'Filling ' + i + ' / ' + n },
      stop: 'Stop',
      attnHead: 'Skipped, for you to handle',
      reasonSensitive: 'SENSITIVE', reasonRequired: 'REQUIRED',
      jump: 'Go',
      doneMsgs: ['All set 🎯', 'Ready to go ✨', 'Nicely done 👏'],
      doneText: function (filled, skipped) {
        var s = filled + (filled === 1 ? ' field filled' : ' fields filled') + ', CV attached.'
        if (skipped > 0) s += ' ' + skipped + (skipped === 1 ? ' field needs' : ' fields need') + ' you (see below).'
        return s
      },
      emptyTitle: 'No application form here',
      emptyBody: 'Open an application page and JobSwiper will offer to fill it.',
      errorTitle: 'Something went wrong',
      fillBtn: function (n) { return 'Fill ' + n + (n === 1 ? ' field' : ' fields') },
      attachCta: 'Attach the CV',
      yourCvs: 'Your tailored CVs',
      use: 'Use', active: 'Active',
      genCv: 'Generate a CV for this offer', openEditor: 'Open the editor',
      cvsEmpty: 'No CV yet. Generate one for this offer.',
      yourApps: 'Your applications',
      viewPipeline: 'View the full pipeline',
      statusApplied: 'Applied', statusInterview: 'Interview', statusDraft: 'Draft', statusInProgress: 'In progress',
      saved: 'Saved', applied: 'Applied',
      activityEmpty: 'No activity yet.',
      profileUsed: 'Profile used for autofill',
      completeness: 'Profile completeness',
      editProfile: 'Edit on JobSwiper',
      pf: {
        full_name: 'Full name', email: 'Email', phone: 'Phone', city: 'Location',
        current_company: 'Current company', linkedin_url: 'LinkedIn', website: 'Website', headline: 'Headline',
      },
      profileEmpty: 'Sign in on JobSwiper to load your profile.',
      yourPlan: 'Your plan',
      planTitle: 'JobSwiper', planSub: 'Manage your plan on JobSwiper',
      managePlan: 'Manage subscription',
      qAutofills: 'Autofills', qUnlimited: 'unlimited',
      signIn: 'Sign in to JobSwiper',
      panelLabel: 'JobSwiper apply assistant',
      timeoutTitle: 'Taking longer than expected',
      timeoutBody: 'The form may have changed. Reopen it, or fill the remaining fields yourself.',
    },
    fr: {
      collapse: 'Réduire',
      state: { detecting: 'Analyse…', ready: 'Prêt', filling: 'Remplissage', done: 'Terminé', empty: 'Aucun formulaire', error: 'Erreur' },
      nav: { apply: 'Postuler', cvs: 'CV', activity: 'Activité', profile: 'Profil', plan: 'Plan' },
      applyWith: 'Candidature avec',
      cvTailored: 'CV SUR-MESURE', cvBase: 'CV DE BASE',
      tailoredFor: 'Adapté à cette offre', genericCv: 'CV générique',
      change: 'Changer',
      detected: function (n) { return n + (n === 1 ? ' champ détecté' : ' champs détectés') },
      formRecognized: 'Formulaire de candidature reconnu',
      profileMatched: 'Profil associé',
      profileMatchedSub: 'Vos infos + le CV sur-mesure',
      fillStep: 'Remplissage des champs',
      filledStep: function (n) { return n + (n === 1 ? ' champ rempli' : ' champs remplis') },
      attachStep: 'Joindre le CV',
      submitStep: 'Prêt à soumettre',
      submitSub: 'La soumission reste la vôtre',
      filling: function (i, n) { return 'Remplissage ' + i + ' / ' + n },
      stop: 'Stop',
      attnHead: 'Ignorés, à vous de gérer',
      reasonSensitive: 'SENSIBLE', reasonRequired: 'REQUIS',
      jump: 'Aller',
      doneMsgs: ['Nickel 🎯', 'C’est prêt ✨', 'Bien joué 👏'],
      doneText: function (filled, skipped) {
        var s = filled + (filled === 1 ? ' champ rempli' : ' champs remplis') + ', CV joint.'
        if (skipped > 0) s += ' ' + skipped + (skipped === 1 ? ' champ vous attend' : ' champs vous attendent') + ' (voir ci-dessous).'
        return s
      },
      emptyTitle: 'Aucun formulaire de candidature ici',
      emptyBody: 'Ouvrez une page de candidature et JobSwiper proposera de la remplir.',
      errorTitle: 'Une erreur est survenue',
      fillBtn: function (n) { return 'Remplir ' + n + (n === 1 ? ' champ' : ' champs') },
      attachCta: 'Joindre le CV',
      yourCvs: 'Vos CV sur-mesure',
      use: 'Utiliser', active: 'Actif',
      genCv: 'Générer un CV pour cette offre', openEditor: 'Ouvrir l’éditeur',
      cvsEmpty: 'Aucun CV pour l’instant. Générez-en un pour cette offre.',
      yourApps: 'Vos candidatures',
      viewPipeline: 'Voir le pipeline complet',
      statusApplied: 'Postulé', statusInterview: 'Entretien', statusDraft: 'Brouillon', statusInProgress: 'En cours',
      saved: 'Enregistrées', applied: 'Postulées',
      activityEmpty: 'Aucune activité pour l’instant.',
      profileUsed: 'Profil utilisé pour l’autofill',
      completeness: 'Complétude du profil',
      editProfile: 'Modifier sur JobSwiper',
      pf: {
        full_name: 'Nom complet', email: 'E-mail', phone: 'Téléphone', city: 'Localisation',
        current_company: 'Société actuelle', linkedin_url: 'LinkedIn', website: 'Site web', headline: 'Titre',
      },
      profileEmpty: 'Connectez-vous à JobSwiper pour charger votre profil.',
      yourPlan: 'Votre offre',
      planTitle: 'JobSwiper', planSub: 'Gérez votre abonnement sur JobSwiper',
      managePlan: 'Gérer l’abonnement',
      qAutofills: 'Autofills', qUnlimited: 'illimité',
      signIn: 'Se connecter à JobSwiper',
      panelLabel: 'Assistant de candidature JobSwiper',
      timeoutTitle: 'Cela prend plus de temps que prévu',
      timeoutBody: 'Le formulaire a peut-être changé. Rouvrez-le, ou remplissez les champs restants vous-même.',
    },
    es: {
      collapse: 'Ocultar',
      state: { detecting: 'Analizando…', ready: 'Listo', filling: 'Rellenando', done: 'Hecho', empty: 'Sin formulario', error: 'Error' },
      nav: { apply: 'Postular', cvs: 'CV', activity: 'Actividad', profile: 'Perfil', plan: 'Plan' },
      applyWith: 'Postulando con',
      cvTailored: 'CV A MEDIDA', cvBase: 'CV BASE',
      tailoredFor: 'Adaptado a esta oferta', genericCv: 'CV genérico',
      change: 'Cambiar',
      detected: function (n) { return n + (n === 1 ? ' campo detectado' : ' campos detectados') },
      formRecognized: 'Formulario de candidatura reconocido',
      profileMatched: 'Perfil asociado',
      profileMatchedSub: 'Tus datos + el CV a medida',
      fillStep: 'Rellenando los campos',
      filledStep: function (n) { return n + (n === 1 ? ' campo rellenado' : ' campos rellenados') },
      attachStep: 'Adjuntar el CV',
      submitStep: 'Listo para enviar',
      submitSub: 'El envío sigue siendo tuyo',
      filling: function (i, n) { return 'Rellenando ' + i + ' / ' + n },
      stop: 'Parar',
      attnHead: 'Omitidos, a tu cargo',
      reasonSensitive: 'SENSIBLE', reasonRequired: 'OBLIGATORIO',
      jump: 'Ir',
      doneMsgs: ['Listo 🎯', 'Ya está ✨', 'Bien hecho 👏'],
      doneText: function (filled, skipped) {
        var s = filled + (filled === 1 ? ' campo rellenado' : ' campos rellenados') + ', CV adjuntado.'
        if (skipped > 0) s += ' ' + skipped + (skipped === 1 ? ' campo te espera' : ' campos te esperan') + ' (ver abajo).'
        return s
      },
      emptyTitle: 'Aquí no hay formulario de candidatura',
      emptyBody: 'Abre una página de candidatura y JobSwiper propondrá rellenarla.',
      errorTitle: 'Algo salió mal',
      fillBtn: function (n) { return 'Rellenar ' + n + (n === 1 ? ' campo' : ' campos') },
      attachCta: 'Adjuntar el CV',
      yourCvs: 'Tus CV a medida',
      use: 'Usar', active: 'Activo',
      genCv: 'Generar un CV para esta oferta', openEditor: 'Abrir el editor',
      cvsEmpty: 'Aún no hay CV. Genera uno para esta oferta.',
      yourApps: 'Tus candidaturas',
      viewPipeline: 'Ver el pipeline completo',
      statusApplied: 'Postulado', statusInterview: 'Entrevista', statusDraft: 'Borrador', statusInProgress: 'En curso',
      saved: 'Guardadas', applied: 'Postuladas',
      activityEmpty: 'Aún no hay actividad.',
      profileUsed: 'Perfil usado para el autofill',
      completeness: 'Completitud del perfil',
      editProfile: 'Editar en JobSwiper',
      pf: {
        full_name: 'Nombre completo', email: 'Correo', phone: 'Teléfono', city: 'Ubicación',
        current_company: 'Empresa actual', linkedin_url: 'LinkedIn', website: 'Sitio web', headline: 'Titular',
      },
      profileEmpty: 'Inicia sesión en JobSwiper para cargar tu perfil.',
      yourPlan: 'Tu plan',
      planTitle: 'JobSwiper', planSub: 'Gestiona tu plan en JobSwiper',
      managePlan: 'Gestionar suscripción',
      qAutofills: 'Autofills', qUnlimited: 'ilimitado',
      signIn: 'Iniciar sesión en JobSwiper',
      panelLabel: 'Asistente de candidatura JobSwiper',
      timeoutTitle: 'Está tardando más de lo esperado',
      timeoutBody: 'El formulario puede haber cambiado. Vuelve a abrirlo, o rellena los campos restantes tú mismo.',
    },
  }

  function pickLang(locale) {
    var raw = locale
    if (!raw) raw = document.documentElement.lang || navigator.language
    raw = (raw || 'en').toLowerCase()
    return raw.indexOf('fr') === 0 ? 'fr' : raw.indexOf('es') === 0 ? 'es' : 'en'
  }
  var lang = pickLang(null)
  function t() { return I18N[lang] || I18N.en }

  // ---- bus binding (guarded, retries until apply-shared initializes it) -------
  function bus() { return window.__jobswiperApply || null }
  function cmd(name, arg) {
    var b = bus()
    if (b && typeof b[name] === 'function') { try { b[name](arg) } catch (e) { /* noop */ } }
  }
  function bindBus(handlers) {
    var tries = 0
    ;(function tryBind() {
      var b = bus()
      if (b && typeof b.on === 'function') {
        Object.keys(handlers).forEach(function (evt) { b.on(evt, handlers[evt]) })
        return
      }
      if (tries++ < 40) setTimeout(tryBind, 50) // ~2s max
    })()
  }

  // ---- styles (ported from the validated prototype; :root -> :host) ----------
  var CSS = [
    ':host{',
    '--blue:#0064be;--blue-hover:#00539d;--blue-050:#eaf2fb;--ink:#18181b;--muted:#6b6b73;--faint:#9a9aa2;',
    '--bg:#eef1f5;--surface:#fff;--surface-2:#f7f8fa;--border:#e6e7ea;--border-strong:#d7d8dd;',
    '--emerald:#059669;--emerald-bg:#ecfdf5;--sunset:#c26a26;--sunset-bg:#fbf1e8;--danger:#dc2626;',
    '--shadow:0 6px 24px rgba(15,23,42,.10),0 0 0 1px rgba(15,23,42,.04);',
    'all:initial;font-family:"Nunito",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
    '}',
    '@media (prefers-color-scheme: dark){:host{',
    '--blue:#4c9be8;--blue-hover:#6cb0f0;--blue-050:rgba(76,155,232,.14);--ink:#f2f2f4;--muted:#a1a1aa;--faint:#7c7c85;',
    '--bg:#0e0f12;--surface:#191a1e;--surface-2:#1f2126;--border:#2a2c32;--border-strong:#34363d;',
    '--emerald:#34d399;--emerald-bg:rgba(16,185,129,.14);--sunset:#e0975a;--sunset-bg:rgba(212,130,63,.14);--danger:#f87171;',
    '--shadow:0 8px 30px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.06);',
    '}}',
    ':host([data-theme="light"]){',
    '--blue:#0064be;--blue-hover:#00539d;--blue-050:#eaf2fb;--ink:#18181b;--muted:#6b6b73;--faint:#9a9aa2;',
    '--bg:#eef1f5;--surface:#fff;--surface-2:#f7f8fa;--border:#e6e7ea;--border-strong:#d7d8dd;',
    '--emerald:#059669;--emerald-bg:#ecfdf5;--sunset:#c26a26;--sunset-bg:#fbf1e8;--danger:#dc2626;',
    '--shadow:0 6px 24px rgba(15,23,42,.10),0 0 0 1px rgba(15,23,42,.04);',
    '}',
    ':host([data-theme="dark"]){',
    '--blue:#4c9be8;--blue-hover:#6cb0f0;--blue-050:rgba(76,155,232,.14);--ink:#f2f2f4;--muted:#a1a1aa;--faint:#7c7c85;',
    '--bg:#0e0f12;--surface:#191a1e;--surface-2:#1f2126;--border:#2a2c32;--border-strong:#34363d;',
    '--emerald:#34d399;--emerald-bg:rgba(16,185,129,.14);--sunset:#e0975a;--sunset-bg:rgba(212,130,63,.14);--danger:#f87171;',
    '--shadow:0 8px 30px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.06);',
    '}',
    '*{margin:0;padding:0;box-sizing:border-box;}',
    'button,input{font-family:inherit;}',
    '.sb{position:fixed;top:14px;right:14px;bottom:14px;width:360px;max-width:calc(100vw - 28px);',
    'background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);',
    'display:flex;flex-direction:column;overflow:hidden;color:var(--ink);',
    'font-size:14px;line-height:1.4;-webkit-font-smoothing:antialiased;',
    'transition:transform .28s cubic-bezier(.4,0,.2,1);z-index:2147483000;}',
    '.sb.collapsed{transform:translateX(384px);}',
    '.tab{position:fixed;top:50%;right:0;transform:translateY(-50%);background:var(--surface);',
    'border:1px solid var(--border);border-right:none;border-radius:12px 0 0 12px;box-shadow:var(--shadow);',
    'padding:12px 8px;cursor:pointer;display:none;flex-direction:column;align-items:center;gap:8px;z-index:2147483000;',
    'writing-mode:vertical-rl;font-weight:800;font-size:12px;letter-spacing:.06em;color:var(--ink);}',
    '.sb.collapsed ~ .tab{display:flex;}',
    '.tab .dot{writing-mode:horizontal-tb;width:22px;height:22px;border-radius:7px;background:var(--blue);color:#fff;display:grid;place-items:center;font-size:11px;}',
    '.tab .tab-logo{writing-mode:horizontal-tb;width:22px;height:22px;border-radius:7px;display:block;object-fit:cover;}',
    '.sb-head{display:flex;align-items:center;gap:9px;padding:13px 14px;border-bottom:1px solid var(--border);}',
    '.brand-logo{width:20px;height:20px;border-radius:6px;flex-shrink:0;display:block;object-fit:cover;}',
    '.wordmark{font-weight:800;font-size:15px;letter-spacing:-.01em;color:var(--ink);}',
    '.wordmark .b{color:var(--blue);}',
    '.state-chip{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;',
    'padding:4px 9px;border-radius:999px;background:var(--surface-2);color:var(--muted);}',
    '.state-chip .sdot{width:7px;height:7px;border-radius:50%;background:var(--faint);}',
    '.state-chip[data-s="ready"]{color:var(--blue);background:var(--blue-050);}',
    '.state-chip[data-s="ready"] .sdot{background:var(--blue);}',
    '.state-chip[data-s="detecting"]{color:var(--blue);background:var(--blue-050);}',
    '.state-chip[data-s="detecting"] .sdot{background:var(--blue);animation:jsw-pulse 1s infinite;}',
    '.state-chip[data-s="filling"]{color:var(--blue);background:var(--blue-050);}',
    '.state-chip[data-s="filling"] .sdot{background:var(--blue);animation:jsw-pulse 1s infinite;}',
    '.state-chip[data-s="done"]{color:var(--emerald);background:var(--emerald-bg);}',
    '.state-chip[data-s="done"] .sdot{background:var(--emerald);}',
    '.state-chip[data-s="error"]{color:var(--danger);background:var(--sunset-bg);}',
    '.state-chip[data-s="error"] .sdot{background:var(--danger);}',
    '@keyframes jsw-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '.icon-btn{border:none;background:none;cursor:pointer;color:var(--faint);width:28px;height:28px;border-radius:7px;display:grid;place-items:center;}',
    '.icon-btn:hover{background:var(--surface-2);color:var(--ink);}',
    '.views{flex:1;overflow-y:auto;overflow-x:hidden;}',
    '.view{display:none;padding:14px;}',
    '.view.active{display:block;animation:jsw-fade .2s ease;}',
    '@keyframes jsw-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '.section-label{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin:2px 0 8px;}',
    '.ctx{display:flex;gap:11px;align-items:center;padding:11px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);}',
    '.cv-thumb{width:42px;height:54px;border-radius:6px;background:linear-gradient(160deg,#dbeafe,#eff6ff);border:1px solid var(--border-strong);flex-shrink:0;position:relative;overflow:hidden;}',
    '.cv-thumb::before{content:"";position:absolute;inset:7px 7px auto 7px;height:5px;border-radius:2px;background:var(--blue);opacity:.7;}',
    '.cv-thumb::after{content:"";position:absolute;left:7px;right:14px;top:18px;height:3px;border-radius:2px;box-shadow:0 6px 0 rgba(100,100,110,.25),0 12px 0 rgba(100,100,110,.25),0 18px 0 rgba(100,100,110,.18);background:rgba(100,100,110,.25);}',
    '.ctx-main{min-width:0;}',
    '.ctx-tag{display:inline-block;font-size:10px;font-weight:800;color:var(--blue);background:var(--blue-050);padding:1px 6px;border-radius:5px;margin-bottom:3px;}',
    '.ctx-title{font-weight:800;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ctx-sub{font-size:11.5px;color:var(--muted);font-weight:600;margin-top:2px;}',
    '.ctx-sub a{color:var(--blue);text-decoration:none;font-weight:700;cursor:pointer;}',
    '.feed{margin-top:14px;position:relative;}',
    '.scan{display:none;height:3px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--blue),transparent);background-size:40% 100%;background-repeat:no-repeat;animation:jsw-scan 1.1s infinite linear;margin-bottom:10px;}',
    '.is-detecting .scan{display:block;}',
    '@keyframes jsw-scan{0%{background-position:-40% 0}100%{background-position:140% 0}}',
    '.step{display:flex;gap:10px;align-items:flex-start;padding:6px 0;}',
    '.step .mk{width:20px;height:20px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;font-size:11px;font-weight:800;border:2px solid var(--border-strong);color:var(--faint);background:var(--surface);margin-top:1px;}',
    '.step .lbl{font-size:13px;font-weight:600;padding-top:2px;color:var(--ink);}',
    '.step .lbl small{display:block;font-size:11.5px;color:var(--muted);font-weight:600;margin-top:1px;}',
    '.step[data-st="done"] .mk{background:var(--emerald);border-color:var(--emerald);color:#fff;}',
    '.step[data-st="active"] .mk{border-color:var(--blue);color:var(--blue);}',
    '.step[data-st="active"] .mk .spin{width:9px;height:9px;border:2px solid var(--blue-050);border-top-color:var(--blue);border-radius:50%;animation:jsw-rot .6s linear infinite;}',
    '.step[data-st="active"] .lbl{color:var(--ink);font-weight:700;}',
    '.step[data-st="pending"]{opacity:.55;}',
    '@keyframes jsw-rot{to{transform:rotate(360deg)}}',
    '.prog-wrap{margin:8px 0 4px 30px;display:none;}',
    '.is-filling .prog-wrap{display:block;}',
    '.prog{height:6px;border-radius:4px;background:var(--surface-2);overflow:hidden;}',
    '.prog > i{display:block;height:100%;width:0;background:var(--blue);border-radius:4px;transition:width .35s ease;}',
    '.prog-meta{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums;}',
    '.stop{color:var(--danger);cursor:pointer;font-weight:800;}',
    '.stop:hover{text-decoration:underline;}',
    '.filled-list{margin:6px 0 2px 30px;display:flex;flex-direction:column;gap:3px;}',
    '.fchip{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--muted);}',
    '.fchip .fk{color:var(--ink);font-weight:700;}',
    '.fchip .tick{color:var(--emerald);font-weight:800;}',
    '.fchip.pending{opacity:.45;}',
    '.fchip.pending .tick{color:var(--faint);}',
    '.done-card{display:none;margin-top:12px;padding:13px;border-radius:12px;background:var(--emerald-bg);border:1px solid color-mix(in srgb, var(--emerald) 22%, transparent);}',
    '.is-done .done-card{display:block;animation:jsw-fade .25s ease;}',
    '.done-card b{font-size:14px;color:var(--ink);}',
    '.done-card p{font-size:12.5px;color:var(--muted);font-weight:600;margin-top:3px;line-height:1.5;}',
    '.msg-card{display:none;margin-top:14px;padding:14px;border-radius:12px;background:var(--surface-2);border:1px solid var(--border);}',
    '.msg-card b{font-size:13.5px;color:var(--ink);}',
    '.msg-card p{font-size:12.5px;color:var(--muted);font-weight:600;margin-top:4px;line-height:1.5;}',
    '.is-empty .empty-card,.is-error .error-card{display:block;}',
    '.is-empty .feed,.is-empty .attn,.is-empty .done-card,.is-empty .cta-row,',
    '.is-error .feed,.is-error .attn,.is-error .done-card{display:none;}',
    '.attn{margin-top:14px;border:1px solid var(--border);border-radius:12px;overflow:hidden;}',
    '.attn-head{display:flex;align-items:center;gap:7px;padding:9px 11px;font-size:12px;font-weight:800;background:var(--surface-2);color:var(--ink);}',
    '.attn-row{display:flex;align-items:center;gap:8px;padding:8px 11px;border-top:1px solid var(--border);font-size:12.5px;font-weight:600;color:var(--ink);}',
    '.attn-row .lock{color:var(--sunset);}',
    '.attn-row .why{margin-left:auto;font-size:10.5px;color:var(--faint);font-weight:700;}',
    '.attn-row.need .lock{color:var(--blue);}',
    '.attn-row .jumpbtn{margin-left:8px;flex-shrink:0;border:1px solid var(--border-strong);background:var(--surface);color:var(--blue);font-family:inherit;font-weight:800;font-size:10.5px;padding:2px 8px;border-radius:6px;cursor:pointer;}',
    '.attn-row .jumpbtn:hover{background:var(--blue-050);}',
    '.cta-row{display:flex;flex-direction:column;gap:8px;margin-top:14px;}',
    '.btn{border:none;border-radius:10px;font-family:inherit;font-weight:800;font-size:13px;padding:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;transition:background .15s,border-color .15s;text-decoration:none;}',
    '.btn-primary{background:var(--blue);color:#fff;}',
    '.btn-primary:hover{background:var(--blue-hover);}',
    '.btn-primary:disabled{opacity:.5;cursor:default;}',
    '.btn-ghost{background:var(--surface);color:var(--ink);border:1px solid var(--border-strong);}',
    '.btn-ghost:hover{background:var(--surface-2);}',
    '.row{display:flex;gap:11px;align-items:center;padding:11px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:var(--surface);}',
    '.row:hover{border-color:var(--border-strong);}',
    '.row.active{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue) inset;}',
    '.row-main{min-width:0;flex:1;}',
    '.row-title{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink);}',
    '.row-sub{font-size:11.5px;color:var(--muted);font-weight:600;margin-top:2px;}',
    '.pill{font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:999px;white-space:nowrap;}',
    '.pill.applied{background:var(--blue-050);color:var(--blue);}',
    '.pill.interview{background:var(--emerald-bg);color:var(--emerald);}',
    '.pill.draft{background:var(--surface-2);color:var(--muted);}',
    '.pill.use{background:var(--blue);color:#fff;}',
    '.link{color:var(--blue);text-decoration:none;font-weight:800;font-size:12px;cursor:pointer;background:none;border:none;}',
    '.link.block{display:block;text-align:center;margin-top:6px;}',
    '.meter{height:6px;border-radius:4px;background:var(--surface-2);overflow:hidden;margin-top:6px;}',
    '.meter > i{display:block;height:100%;border-radius:4px;}',
    '.quota{padding:11px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;}',
    '.quota-top{display:flex;justify-content:space-between;font-size:12.5px;font-weight:700;color:var(--ink);}',
    '.quota-top .n{color:var(--muted);font-variant-numeric:tabular-nums;}',
    '.kv{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);font-size:12.5px;}',
    '.kv:last-of-type{border-bottom:none;}',
    '.kv .k{color:var(--muted);font-weight:600;flex-shrink:0;}',
    '.kv .v{font-weight:700;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;}',
    '.nav{display:flex;border-top:1px solid var(--border);background:var(--surface);}',
    '.nav button{flex:1;border:none;background:none;cursor:pointer;padding:9px 4px 8px;display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--faint);font-family:inherit;font-size:9.5px;font-weight:800;letter-spacing:.02em;}',
    '.nav button svg{width:19px;height:19px;}',
    '.nav button.active{color:var(--blue);}',
    '.nav button:hover{color:var(--ink);}',
    '.nav button.active:hover{color:var(--blue);}',
    '.muted-note{font-size:12px;color:var(--muted);font-weight:600;line-height:1.5;padding:2px 0 8px;}',
    '@media (prefers-reduced-motion: reduce){*{animation:none !important;transition:none !important;}}',
    '@media (max-width: 720px){.sb{left:14px;width:auto;}}',
  ].join('')

  // ---- SVG icon fragments ----------------------------------------------------
  var IC = {
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l4 4L20 5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    navApply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l4 4L20 5"/></svg>',
    navCv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/></svg>',
    navActivity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
    navProfile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    navPlan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.6 6.6L22 9l-5 4.6L18.4 21 12 17.3 5.6 21 7 13.6 2 9l7.4-.4z"/></svg>',
  }

  // ---- utils -----------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function clamp01(n) { return Math.max(0, Math.min(100, n)) }

  // ---- markup ----------------------------------------------------------------
  function shellHTML() {
    var T = t()
    var logo = logoUrl()
    var headLogo = logo ? '<img class="brand-logo" src="' + esc(logo) + '" alt="" width="20" height="20">' : ''
    var tabLogo = logo ? '<img class="tab-logo" src="' + esc(logo) + '" alt="" width="22" height="22">' : '<span class="dot">JS</span>'
    return (
      '<style>' + CSS + '</style>' +
      '<aside class="sb" id="sb" aria-label="' + esc(T.panelLabel) + '">' +
        '<div class="sb-head">' +
          headLogo +
          '<span class="wordmark">Job<span class="b">Swiper</span></span>' +
          '<span class="state-chip" id="chip" data-s="detecting" role="status" aria-live="polite" aria-atomic="true"><span class="sdot"></span><span id="chipText">' + esc(T.state.detecting) + '</span></span>' +
          '<button class="icon-btn" id="collapseBtn" title="' + esc(T.collapse) + '" aria-label="' + esc(T.collapse) + '">' + IC.chevron + '</button>' +
        '</div>' +
        '<div class="views">' +
          // APPLY
          '<section class="view active is-detecting" id="view-apply">' +
            '<div class="section-label" id="applyLabel">' + esc(T.applyWith) + '</div>' +
            '<div class="ctx" id="ctx">' +
              '<div class="cv-thumb"></div>' +
              '<div class="ctx-main">' +
                '<span class="ctx-tag" id="ctxTag">' + esc(T.cvTailored) + '</span>' +
                '<div class="ctx-title" id="ctxTitle">&nbsp;</div>' +
                '<div class="ctx-sub" id="ctxSub"><a id="ctxChange">' + esc(T.change) + '</a></div>' +
              '</div>' +
            '</div>' +
            '<div class="feed" id="feed">' +
              '<div class="scan"></div>' +
              '<div class="step" data-step="detect" data-st="pending"><div class="mk" id="detectMk">1</div><div class="lbl" id="detectLbl">' + esc(T.fillStep) + '</div></div>' +
              '<div class="step" data-step="match" data-st="pending"><div class="mk">2</div><div class="lbl">' + esc(T.profileMatched) + '<small>' + esc(T.profileMatchedSub) + '</small></div></div>' +
              '<div class="step" data-step="fill" data-st="pending"><div class="mk" id="fillMk">3</div><div class="lbl" id="fillLbl">' + esc(T.fillStep) + '</div></div>' +
              '<div class="prog-wrap"><div class="prog" id="progEl" role="progressbar" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><i id="progBar"></i></div>' +
                '<div class="prog-meta"><span id="progText">' + esc(T.filling(0, 0)) + '</span><span class="stop" id="stopBtn">■ ' + esc(T.stop) + '</span></div></div>' +
              '<div class="filled-list" id="filledList"></div>' +
              '<div class="step" data-step="attach" data-st="pending"><div class="mk">↑</div><div class="lbl" id="attachLbl">' + esc(T.attachStep) + '</div></div>' +
              '<div class="step" data-step="submit" data-st="pending"><div class="mk">▷</div><div class="lbl">' + esc(T.submitStep) + '<small>' + esc(T.submitSub) + '</small></div></div>' +
            '</div>' +
            '<div class="done-card"><b id="doneTitle">' + esc(T.doneMsgs[0]) + '</b><p id="doneText"></p></div>' +
            '<div class="msg-card empty-card"><b>' + esc(T.emptyTitle) + '</b><p>' + esc(T.emptyBody) + '</p></div>' +
            '<div class="msg-card error-card"><b id="errorTitle">' + esc(T.errorTitle) + '</b><p id="errorText"></p></div>' +
            '<div class="attn" id="attn" style="display:none"><div class="attn-head" id="attnHead">' + esc(T.attnHead) + '</div><div id="attnRows"></div></div>' +
            '<div class="cta-row" id="applyCta">' +
              '<button class="btn btn-primary" id="fillBtn" disabled>' + IC.check + '<span id="fillBtnText">' + esc(T.fillBtn(0)) + '</span></button>' +
              '<button class="btn btn-ghost" id="cvBtn">' + esc(T.attachCta) + '</button>' +
            '</div>' +
          '</section>' +
          // CVS
          '<section class="view" id="view-cvs">' +
            '<div class="section-label" id="cvsLabel">' + esc(T.yourCvs) + '</div>' +
            '<div id="cvsList"></div>' +
            '<div class="cta-row">' +
              '<a class="btn btn-primary" id="genCvBtn" href="' + API_BASE + '/dashboard/cvs" target="_blank" rel="noreferrer noopener">' + IC.plus + '<span id="genCvText">' + esc(T.genCv) + '</span></a>' +
              '<a class="btn btn-ghost" id="openEditorBtn" href="' + API_BASE + '/dashboard/cvs" target="_blank" rel="noreferrer noopener">' + esc(T.openEditor) + '</a>' +
            '</div>' +
          '</section>' +
          // ACTIVITY
          '<section class="view" id="view-activity">' +
            '<div class="section-label" id="activityLabel">' + esc(T.yourApps) + '</div>' +
            '<div id="activityList"></div>' +
            '<a class="link block" id="viewPipelineLink" href="' + API_BASE + '/dashboard/pipeline" target="_blank" rel="noreferrer noopener">' + esc(T.viewPipeline) + ' →</a>' +
          '</section>' +
          // PROFILE
          '<section class="view" id="view-profile">' +
            '<div class="section-label" id="profileLabel">' + esc(T.profileUsed) + '</div>' +
            '<div id="profileBody"></div>' +
            '<a class="btn btn-ghost" id="editProfileBtn" href="' + API_BASE + '/dashboard/profile" target="_blank" rel="noreferrer noopener" style="margin-top:12px">' + esc(T.editProfile) + '</a>' +
          '</section>' +
          // PLAN (static placeholder for v1)
          '<section class="view" id="view-plan">' +
            '<div class="section-label" id="planLabel">' + esc(T.yourPlan) + '</div>' +
            '<div class="ctx" style="margin-bottom:12px"><div class="ctx-main"><span class="ctx-tag" id="planTag">' + esc(T.planTitle) + '</span><div class="ctx-title" id="planTitleEl">' + esc(T.planTitle) + '</div><div class="ctx-sub" id="planSubEl">' + esc(T.planSub) + '</div></div></div>' +
            '<div class="quota"><div class="quota-top"><span id="qAutofillsEl">' + esc(T.qAutofills) + '</span><span class="n" id="qUnlimitedEl">' + esc(T.qUnlimited) + '</span></div><div class="meter"><i style="width:100%;background:var(--blue)"></i></div></div>' +
            '<a class="btn btn-ghost" id="managePlanBtn" href="' + API_BASE + '/dashboard/settings/billing" target="_blank" rel="noreferrer noopener" style="margin-top:6px">' + esc(T.managePlan) + '</a>' +
          '</section>' +
        '</div>' +
        '<nav class="nav" id="nav">' +
          '<button class="active" data-view="apply">' + IC.navApply + esc(T.nav.apply) + '</button>' +
          '<button data-view="cvs">' + IC.navCv + esc(T.nav.cvs) + '</button>' +
          '<button data-view="activity">' + IC.navActivity + esc(T.nav.activity) + '</button>' +
          '<button data-view="profile">' + IC.navProfile + esc(T.nav.profile) + '</button>' +
          '<button data-view="plan">' + IC.navPlan + esc(T.nav.plan) + '</button>' +
        '</nav>' +
      '</aside>' +
      '<div class="tab" id="tab">' + tabLogo + 'JobSwiper</div>'
    )
  }

  // ---- component state -------------------------------------------------------
  var root = null          // shadow root
  var sbEl = null          // .sb
  var applyView = null     // #view-apply
  var chipEl = null, chipText = null
  var readyFields = []     // [{key,label,value}] from the last ready event
  var chipMap = []         // seeded fchip elements (index-aligned to readyFields)
  var userSetCollapse = false
  var loaded = { cvs: false, activity: false, profile: false }
  var lastSkipped = 0
  var lastSkippedList = []  // the last detection skipped array, so readback fails append to it
  var fillWatchdog = null   // fires if a started fill never reports progress/done
  var currentState = 'detecting' // mirrors the .is-<state> on #view-apply
  // Once the user starts a fill, lock the apply view so the post-fill re-detect
  // (which now sees 0 fillable inputs, because they are filled) cannot downgrade
  // the feed back to "0 fields / Ready". Unlocks only on a genuinely new form.
  var flowLocked = false

  var NAV_ICON = { apply: IC.navApply, cvs: IC.navCv, activity: IC.navActivity, profile: IC.navProfile, plan: IC.navPlan }

  function $(id) { return root ? root.getElementById(id) : null }

  function setState(s) {
    currentState = s
    if (applyView) applyView.className = 'view active is-' + s
    if (chipEl) chipEl.setAttribute('data-s', s)
    if (chipText) chipText.textContent = (t().state[s] || '')
  }

  // Re-apply every static, table-backed string in the current language. Called
  // after any late locale flip (boot GET_PROFILE, primeContextFallback,
  // loadProfile) so the shell, which is built once at mount, never keeps stale
  // English when the user's app locale resolves to fr/es afterwards. Dynamic,
  // state-driven strings (detected count, progress N/M, done copy, ctx card) are
  // owned by their handlers and only re-applied here when it is safe for the
  // current state, so relocalizing never clobbers live content.
  function relocalize() {
    if (!root) return
    var T = t()
    // header
    var cb = $('collapseBtn'); if (cb) { cb.setAttribute('title', T.collapse); cb.setAttribute('aria-label', T.collapse) }
    var sbA = $('sb'); if (sbA) sbA.setAttribute('aria-label', T.panelLabel)
    if (chipText) chipText.textContent = T.state[currentState] || ''
    // apply view: section label + non-dynamic feed steps
    setTextById('applyLabel', T.applyWith)
    var matchLbl = applyView && applyView.querySelector('.step[data-step="match"] .lbl')
    if (matchLbl) matchLbl.innerHTML = esc(T.profileMatched) + '<small>' + esc(T.profileMatchedSub) + '</small>'
    var submitLbl = applyView && applyView.querySelector('.step[data-step="submit"] .lbl')
    if (submitLbl) submitLbl.innerHTML = esc(T.submitStep) + '<small>' + esc(T.submitSub) + '</small>'
    // attach label: keep an appended cv name (attaching/done) if present
    var attachLbl = $('attachLbl'); if (attachLbl && !attachLbl.querySelector('small')) attachLbl.textContent = T.attachStep
    // detect / fill labels are state-owned; only reset while still detecting
    if (currentState === 'detecting') { var dl = $('detectLbl'); if (dl) dl.textContent = T.state.detecting }
    var sb = $('stopBtn'); if (sb) sb.textContent = '■ ' + T.stop
    if (currentState !== 'filling' && currentState !== 'done') {
      var pt = $('progText'); if (pt) pt.textContent = T.filling(0, readyFields.length)
    }
    var fbt = $('fillBtnText'); if (fbt) fbt.textContent = T.fillBtn(readyFields.length)
    var cvBtn = $('cvBtn'); if (cvBtn) cvBtn.textContent = T.attachCta
    if (currentState !== 'done') { var dt = $('doneTitle'); if (dt) dt.textContent = T.doneMsgs[0] }
    // message cards + skipped header
    var eb = applyView && applyView.querySelector('.empty-card b'); if (eb) eb.textContent = T.emptyTitle
    var ep = applyView && applyView.querySelector('.empty-card p'); if (ep) ep.textContent = T.emptyBody
    var errb = applyView && applyView.querySelector('.error-card b'); if (errb && currentState !== 'error') errb.textContent = T.errorTitle
    setTextById('attnHead', T.attnHead)
    // ctx card defaults (renderCtx owns it once a ctx event lands)
    if (!window.__jobswiperSidebarCtxSeen) {
      var tag = $('ctxTag'); if (tag) tag.textContent = T.cvTailored
      var chg = $('ctxChange'); if (chg) chg.textContent = T.change
    }
    // secondary views
    setTextById('cvsLabel', T.yourCvs)
    setTextById('genCvText', T.genCv)
    setTextById('openEditorBtn', T.openEditor)
    setTextById('activityLabel', T.yourApps)
    var vp = $('viewPipelineLink'); if (vp) vp.textContent = T.viewPipeline + ' →'
    setTextById('profileLabel', T.profileUsed)
    setTextById('editProfileBtn', T.editProfile)
    setTextById('planLabel', T.yourPlan)
    setTextById('planTag', T.planTitle)
    setTextById('planTitleEl', T.planTitle)
    setTextById('planSubEl', T.planSub)
    setTextById('qAutofillsEl', T.qAutofills)
    setTextById('qUnlimitedEl', T.qUnlimited)
    setTextById('managePlanBtn', T.managePlan)
    // bottom nav labels (keep each button's leading SVG icon)
    var navEl = $('nav')
    if (navEl) {
      var nb = navEl.querySelectorAll('button')
      for (var i = 0; i < nb.length; i++) {
        var v = nb[i].getAttribute('data-view')
        if (v && T.nav[v]) nb[i].innerHTML = (NAV_ICON[v] || '') + esc(T.nav[v])
      }
    }
  }

  function setTextById(id, s) { var e = $(id); if (e) e.textContent = s }
  function stepEl(name) { return applyView ? applyView.querySelector('.step[data-step="' + name + '"]') : null }
  function setStep(name, st) { var el = stepEl(name); if (el) el.setAttribute('data-st', st) }

  // ---- render helpers --------------------------------------------------------
  function renderCtx(data) {
    var T = t()
    var cv = (data && data.cv) || {}
    var tailored = !!cv.tailored
    var tag = $('ctxTag'), title = $('ctxTitle'), sub = $('ctxSub'), change = $('ctxChange')
    if (tag) tag.textContent = tailored ? T.cvTailored : T.cvBase
    if (title) title.textContent = cv.name || (tailored ? T.cvTailored : T.cvBase)
    if (sub) {
      var bits = []
      bits.push(tailored ? T.tailoredFor : T.genericCv)
      if (data && data.profileName) bits.push(data.profileName)
      sub.textContent = bits.join(' · ') + ' · '
      var a = document.createElement('a')
      a.id = 'ctxChange'; a.textContent = T.change
      a.addEventListener('click', function () { switchView('cvs') })
      sub.appendChild(a)
    } else if (change) {
      change.addEventListener('click', function () { switchView('cvs') })
    }
  }

  function pillClassFor(status) {
    var s = String(status || '').toLowerCase()
    if (s.indexOf('interview') !== -1 || s.indexOf('entretien') !== -1 || s.indexOf('entrevist') !== -1) return 'interview'
    if (s.indexOf('draft') !== -1 || s.indexOf('brouillon') !== -1 || s.indexOf('borrador') !== -1) return 'draft'
    return 'applied'
  }
  function statusLabel(status) {
    var T = t(), s = String(status || '').toLowerCase()
    if (s.indexOf('interview') !== -1 || s.indexOf('entretien') !== -1 || s.indexOf('entrevist') !== -1) return T.statusInterview
    if (s.indexOf('draft') !== -1 || s.indexOf('brouillon') !== -1 || s.indexOf('borrador') !== -1) return T.statusDraft
    if (s.indexOf('progress') !== -1 || s.indexOf('cours') !== -1 || s.indexOf('curso') !== -1) return T.statusInProgress
    return T.statusApplied
  }

  // ---- data views ------------------------------------------------------------
  function loadCvs() {
    var el = $('cvsList'); if (!el) return
    send({ type: 'GET_CVS' }, function (resp) {
      var T = t()
      if (!resp || !resp.ok || !Array.isArray(resp.cvs) || resp.cvs.length === 0) {
        el.innerHTML = '<div class="muted-note">' + esc(T.cvsEmpty) + '</div>'
        return
      }
      var current = resp.selectedCvId || resp.defaultCvId || (resp.cvs[0] && resp.cvs[0].id)
      var html = ''
      resp.cvs.forEach(function (cv) {
        var isActive = cv.id === current
        html += '<div class="row' + (isActive ? ' active' : '') + '">' +
          '<div class="cv-thumb" style="width:34px;height:44px"></div>' +
          '<div class="row-main"><div class="row-title">' + esc(cv.title || 'CV') + '</div>' +
          '<div class="row-sub">' + esc(cv.isPerJob ? T.tailoredFor : T.genericCv) + '</div></div>' +
          (isActive
            ? '<span class="pill use">' + esc(T.active) + '</span>'
            : '<button class="link" data-cv-id="' + esc(cv.id) + '">' + esc(T.use) + '</button>') +
          '</div>'
      })
      el.innerHTML = html
      var btns = el.querySelectorAll('button[data-cv-id]')
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function () {
          var id = this.getAttribute('data-cv-id')
          cmd('selectCv', id)
          loaded.cvs = false
          setTimeout(loadCvs, 250)
        })
      }
    })
  }

  function loadActivity() {
    var el = $('activityList'); if (!el) return
    send({ type: 'GET_STATS' }, function (resp) {
      var T = t()
      if (!resp || !resp.ok) {
        el.innerHTML = '<div class="muted-note">' + esc(T.activityEmpty) + '</div>'
        return
      }
      var recent = Array.isArray(resp.recent) ? resp.recent : []
      var html = ''
      if (recent.length) {
        recent.slice(0, 8).forEach(function (r) {
          var title = r.title || r.job_title || r.role || 'Job'
          var company = r.company || r.company_name || ''
          var where = r.location || r.city || r.when || r.updated_at || ''
          var pc = pillClassFor(r.status)
          html += '<div class="row"><div class="row-main">' +
            '<div class="row-title">' + esc(title) + (company ? ' · ' + esc(company) : '') + '</div>' +
            (where ? '<div class="row-sub">' + esc(where) + '</div>' : '') +
            '</div><span class="pill ' + pc + '">' + esc(statusLabel(r.status)) + '</span></div>'
        })
      } else {
        var saved = resp.saved != null ? resp.saved : (resp.savedCount != null ? resp.savedCount : null)
        var applied = resp.applied != null ? resp.applied : (resp.appliedCount != null ? resp.appliedCount : null)
        if (saved == null && applied == null) {
          html = '<div class="muted-note">' + esc(T.activityEmpty) + '</div>'
        } else {
          if (saved != null) html += '<div class="kv"><span class="k">' + esc(T.saved) + '</span><span class="v">' + esc(saved) + '</span></div>'
          if (applied != null) html += '<div class="kv"><span class="k">' + esc(T.applied) + '</span><span class="v">' + esc(applied) + '</span></div>'
        }
      }
      el.innerHTML = html
    })
  }

  function loadProfile() {
    var el = $('profileBody'); if (!el) return
    send({ type: 'GET_PROFILE' }, function (resp) {
      var T = t()
      if (resp && resp.locale) { var nl = pickLang(resp.locale); if (nl !== lang) { lang = nl; T = t(); relocalize() } }
      if (!resp || !resp.ok || !resp.profile) {
        el.innerHTML = '<div class="muted-note">' + esc(T.profileEmpty) + '</div>' +
          '<a class="btn btn-ghost" href="' + API_BASE + '/login" target="_blank" rel="noreferrer noopener" style="margin-top:8px">' + esc(T.signIn) + '</a>'
        return
      }
      var p = resp.profile
      var html = ''
      var comp = resp.completeness
      if (comp != null) {
        var pct = clamp01(comp <= 1 ? comp * 100 : comp)
        var col = pct >= 80 ? 'var(--emerald)' : pct >= 50 ? 'var(--blue)' : 'var(--sunset)'
        html += '<div class="quota" style="margin-bottom:12px"><div class="quota-top"><span>' + esc(T.completeness) + '</span>' +
          '<span class="n">' + Math.round(pct) + '%</span></div><div class="meter"><i style="width:' + pct + '%;background:' + col + '"></i></div></div>'
      }
      var fullName = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name
      var rows = [
        ['full_name', fullName],
        ['email', p.email],
        ['phone', p.phone],
        ['city', p.city || p.location],
        ['current_company', p.current_company || p.company],
        ['headline', p.headline],
        ['linkedin_url', p.linkedin_url || p.linkedin],
        ['website', p.website],
      ]
      var any = false
      rows.forEach(function (r) {
        if (!r[1]) return
        any = true
        html += '<div class="kv"><span class="k">' + esc(T.pf[r[0]] || r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>'
      })
      if (!any) html = '<div class="muted-note">' + esc(T.profileEmpty) + '</div>'
      el.innerHTML = html
    })
  }

  // Build a fallback context card from GET_CVS + GET_PROFILE, in case the ctx
  // bus event fired before this sidebar subscribed.
  function primeContextFallback() {
    send({ type: 'GET_PROFILE' }, function (pr) {
      if (pr && pr.locale) { var nl = pickLang(pr.locale); if (nl !== lang && !window.__jobswiperSidebarCtxSeen) { lang = nl; relocalize() } }
      var profileName = null
      if (pr && pr.ok && pr.profile) {
        var p = pr.profile
        profileName = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || null
      }
      send({ type: 'GET_CVS' }, function (cr) {
        if (window.__jobswiperSidebarCtxSeen) return // real ctx already rendered
        var cv = {}
        if (cr && cr.ok && Array.isArray(cr.cvs) && cr.cvs.length) {
          var curId = cr.selectedCvId || cr.defaultCvId || cr.cvs[0].id
          var chosen = null
          for (var i = 0; i < cr.cvs.length; i++) { if (cr.cvs[i].id === curId) { chosen = cr.cvs[i]; break } }
          chosen = chosen || cr.cvs[0]
          cv = { name: chosen.title || null, tailored: !!chosen.isPerJob }
        }
        renderCtx({ cv: cv, profileName: profileName })
      })
    })
  }

  // ---- apply state machine (driven by the bus) -------------------------------
  function onCtx(data) {
    window.__jobswiperSidebarCtxSeen = true
    renderCtx(data)
  }

  function onDetecting() {
    if (flowLocked) return // do not flip a filled/done view back to "Analyzing…"
    setState('detecting')
    setStep('detect', 'active')
    var mk = $('detectMk'); if (mk) mk.innerHTML = '<span class="spin"></span>'
    var dl = $('detectLbl'); if (dl) dl.textContent = t().state.detecting
  }

  function onReady(data) {
    var T = t()
    var fields = (data && Array.isArray(data.fields)) ? data.fields : []
    if (flowLocked) {
      // Post-fill re-detect on the SAME form now sees 0 fillable inputs (they are
      // filled): ignore it so the done summary sticks. A genuinely new/changed
      // form (fields > 0) is worth showing, so unlock and render it.
      if (fields.length === 0) return
      flowLocked = false
    }
    readyFields = fields
    var skipped = (data && Array.isArray(data.skipped)) ? data.skipped : []
    lastSkipped = skipped.length
    lastSkippedList = skipped
    setState('ready')
    // detect step -> done
    setStep('detect', 'done')
    var mk = $('detectMk'); if (mk) { mk.innerHTML = ''; mk.textContent = '✓' }
    var dl = $('detectLbl')
    if (dl) dl.innerHTML = esc(T.detected(readyFields.length)) + '<small>' + esc(T.formRecognized) + '</small>'
    // match step -> done
    setStep('match', 'done')
    var mMk = applyView.querySelector('.step[data-step="match"] .mk'); if (mMk) mMk.textContent = '✓'
    // fill step -> pending, counter = N
    setStep('fill', 'pending')
    var fmk = $('fillMk'); if (fmk) { fmk.innerHTML = ''; fmk.textContent = String(readyFields.length) }
    var fl = $('fillLbl'); if (fl) fl.textContent = T.fillStep
    // reset progress + filled list
    var pb = $('progBar'); if (pb) pb.style.width = '0'
    var pe = $('progEl'); if (pe) { pe.setAttribute('aria-valuemax', String(readyFields.length)); pe.setAttribute('aria-valuenow', '0') }
    var pt = $('progText'); if (pt) pt.textContent = T.filling(0, readyFields.length)
    var fList = $('filledList'); if (fList) fList.innerHTML = ''
    chipMap = []
    // attach + submit pending
    setStep('attach', 'pending'); setStep('submit', 'pending')
    // skipped list
    renderSkipped(skipped)
    // CTA
    var fb = $('fillBtn'); if (fb) fb.disabled = readyFields.length === 0
    var fbt = $('fillBtnText'); if (fbt) fbt.textContent = T.fillBtn(readyFields.length)
    // auto-expand once when a form is found (unless the user chose collapse)
    if (!userSetCollapse) expand()
  }

  function renderSkipped(skipped) {
    var T = t()
    var attn = $('attn'), rows = $('attnRows')
    if (!attn || !rows) return
    if (!skipped.length) { attn.style.display = 'none'; rows.innerHTML = ''; return }
    attn.style.display = ''
    rows.innerHTML = ''
    skipped.forEach(function (sk) {
      var required = sk.reason === 'required'
      var why = required ? T.reasonRequired : T.reasonSensitive
      var row = document.createElement('div')
      row.className = 'attn-row' + (required ? ' need' : '')
      var lock = document.createElement('span')
      lock.className = 'lock'; lock.textContent = required ? '◉' : '🔒'
      row.appendChild(lock)
      row.appendChild(document.createTextNode(sk.label || ''))
      var whyEl = document.createElement('span')
      whyEl.className = 'why'; whyEl.textContent = why
      row.appendChild(whyEl)
      // Jump affordance only for REQUIRED rows we hold a live input ref for.
      // Sensitive fields deliberately get no jump: the sidebar declined to touch
      // them for privacy, so it must not shortcut the user to them either.
      if (required && sk.input && sk.input.nodeType === 1) {
        var jump = document.createElement('button')
        jump.className = 'jumpbtn'; jump.type = 'button'; jump.textContent = T.jump
        ;(function (target) {
          jump.addEventListener('click', function (e) { e.stopPropagation(); jumpToField(target) })
        })(sk.input)
        row.appendChild(jump)
      }
      rows.appendChild(row)
    })
  }

  // Scroll the page to a skipped field and pulse it, so "REQUIRED" rows are not
  // just a list but a shortcut. Styling the page node is fine (same document);
  // wrapped in try/catch since the node may have been removed since detection.
  var pulsingFields = (typeof WeakSet !== 'undefined') ? new WeakSet() : null
  function jumpToField(input) {
    try {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (typeof input.focus === 'function') {
        try { input.focus({ preventScroll: true }) } catch (e) { input.focus() }
      }
      // Skip re-pulsing while a pulse is in flight, otherwise a double-click would
      // snapshot the already-blue outline and leave it stuck blue.
      if (pulsingFields && pulsingFields.has(input)) return
      if (pulsingFields) pulsingFields.add(input)
      var po = input.style.outline, poff = input.style.outlineOffset
      input.style.outline = '2px solid #0064be'
      input.style.outlineOffset = '2px'
      setTimeout(function () {
        input.style.outline = po; input.style.outlineOffset = poff
        if (pulsingFields) pulsingFields.delete(input)
      }, 1600)
    } catch (e) { /* node gone; nothing to jump to */ }
  }

  function seedFilledChips() {
    var fList = $('filledList'); if (!fList) return
    fList.innerHTML = ''
    chipMap = []
    readyFields.forEach(function (f, i) {
      var div = document.createElement('div')
      div.className = 'fchip pending'
      div.innerHTML = '<span class="tick">○</span><span class="fk">' + esc(f.label || f.key || '') + '</span>'
      fList.appendChild(div)
      chipMap[i] = div
    })
  }

  // Enter the 'filling' visual state: chip + fill step spinner, seeded field
  // chips, disabled button, zeroed progress. Called optimistically the moment
  // the user clicks Fill (so the UI responds and locks before any re-detect),
  // and defensively from onProgress in case a progress event arrives first.
  function enterFilling() {
    flowLocked = true
    setState('filling')
    setStep('fill', 'active')
    var fmk = $('fillMk'); if (fmk) fmk.innerHTML = '<span class="spin"></span>'
    if (!chipMap.length) seedFilledChips()
    var fb = $('fillBtn'); if (fb) fb.disabled = true
    var pt = $('progText'); if (pt) pt.textContent = t().filling(0, readyFields.length)
    armFillWatchdog()
  }

  function onProgress(data) {
    var T = t()
    if (!data) return
    var total = data.total || readyFields.length || 0
    var index = data.index || 0
    if (applyView && applyView.className.indexOf('is-filling') === -1) {
      enterFilling()
    }
    armFillWatchdog() // progress means the fill is moving; reset the stall timer
    var pb = $('progBar'); if (pb && total) pb.style.width = (index / total * 100) + '%'
    var pe = $('progEl'); if (pe) { pe.setAttribute('aria-valuemax', String(total)); pe.setAttribute('aria-valuenow', String(index)) }
    var pt = $('progText'); if (pt) pt.textContent = T.filling(index, total)
    // tick chips up to index
    for (var i = 0; i < index && i < chipMap.length; i++) {
      var c = chipMap[i]
      if (c && c.classList.contains('pending')) {
        c.classList.remove('pending')
        var tk = c.querySelector('.tick'); if (tk) tk.textContent = '✓'
      }
    }
  }

  function onFilled(data) {
    var T = t()
    clearFillWatchdog()
    var count = data && data.count != null ? data.count : readyFields.length
    setStep('fill', 'done')
    var fmk = $('fillMk'); if (fmk) { fmk.innerHTML = ''; fmk.textContent = '✓' }
    var fl = $('fillLbl'); if (fl) fl.textContent = T.filledStep(count)
    // tick any remaining seeded chips
    for (var i = 0; i < chipMap.length; i++) {
      var c = chipMap[i]
      if (c && c.classList.contains('pending')) {
        c.classList.remove('pending')
        var tk = c.querySelector('.tick'); if (tk) tk.textContent = '✓'
      }
    }
  }

  function onAttach(data) {
    var T = t()
    var status = data && data.status
    if (status === 'attaching') {
      setStep('attach', 'active')
      var al = $('attachLbl')
      if (al && data.cvName) al.innerHTML = esc(T.attachStep) + '<small>' + esc(data.cvName) + '</small>'
    } else if (status === 'done') {
      setStep('attach', 'done')
    } else if (status === 'error') {
      setStep('attach', 'pending')
    }
  }

  function onDone(data) {
    var T = t()
    clearFillWatchdog()
    var filled = data && data.filled != null ? data.filled : readyFields.length
    var skipped = data && data.skipped != null ? data.skipped : lastSkipped
    setState('done')
    setStep('fill', 'done')
    setStep('submit', 'done')
    var dt = $('doneTitle')
    if (dt) dt.textContent = T.doneMsgs[Math.floor(Date.now() / 1000) % T.doneMsgs.length]
    var dx = $('doneText'); if (dx) dx.textContent = T.doneText(filled, skipped)
    // Fields that were attempted but did not stick (readback failures) are routed
    // into the skipped list so the "needs you" panel reflects the honest state,
    // and their optimistic ✓ chip is reverted so nothing reads as both filled and
    // still-needed.
    if (data && Array.isArray(data.unfilled) && data.unfilled.length) {
      renderSkipped(lastSkippedList.concat(data.unfilled))
      untickChips(data.unfilled)
    }
  }

  function untickChips(unfilled) {
    if (!chipMap.length) return
    var labels = Object.create(null)
    unfilled.forEach(function (u) { if (u && u.label) labels[u.label] = true })
    for (var i = 0; i < chipMap.length; i++) {
      var c = chipMap[i]; if (!c) continue
      var fk = c.querySelector('.fk')
      if (fk && labels[fk.textContent]) {
        c.classList.add('pending')
        var tk = c.querySelector('.tick'); if (tk) tk.textContent = '○'
      }
    }
  }

  function onEmpty() {
    clearFillWatchdog()
    if (flowLocked) return // keep the done summary; the filled form still exists
    setState('empty')
    var fb = $('fillBtn'); if (fb) fb.disabled = true
  }

  function onError(data) {
    clearFillWatchdog()
    flowLocked = false // a real failure always surfaces
    setState('error')
    var et = $('errorTitle'); if (et) et.textContent = t().errorTitle
    var ex = $('errorText')
    if (ex) ex.textContent = (data && data.message) ? String(data.message) : ''
  }

  // ---- fill watchdog ---------------------------------------------------------
  // The user clicks Fill -> enterFilling() locks the view optimistically, then
  // startFill runs an async SW round-trip. If that round-trip (or the fill loop)
  // never reports back, the sidebar would sit in "Filling" forever. The watchdog
  // surfaces a distinct timeout state instead. It is (re)armed on each progress
  // tick, so only a genuine stall trips it, and cleared on any terminal event.
  function armFillWatchdog() {
    clearFillWatchdog()
    fillWatchdog = setTimeout(onFillTimeout, 15000)
  }
  function clearFillWatchdog() {
    if (fillWatchdog) { clearTimeout(fillWatchdog); fillWatchdog = null }
  }
  function onFillTimeout() {
    fillWatchdog = null
    if (currentState !== 'filling') return
    flowLocked = false
    var T = t()
    setState('error')
    var et = $('errorTitle'); if (et) et.textContent = T.timeoutTitle
    var ex = $('errorText'); if (ex) ex.textContent = T.timeoutBody
  }

  // ---- view switching + collapse ---------------------------------------------
  function switchView(name) {
    if (!root) return
    var btns = root.querySelectorAll('.nav button')
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-view') === name)
    }
    var views = root.querySelectorAll('.view')
    for (var j = 0; j < views.length; j++) views[j].classList.remove('active')
    var target = $('view-' + name)
    if (target) target.classList.add('active')
    if (name === 'cvs' && !loaded.cvs) { loaded.cvs = true; loadCvs() }
    if (name === 'activity' && !loaded.activity) { loaded.activity = true; loadActivity() }
    if (name === 'profile' && !loaded.profile) { loaded.profile = true; loadProfile() }
  }

  function collapse() {
    if (sbEl) sbEl.classList.add('collapsed')
    userSetCollapse = true
    storageSet({ sidebarCollapsed: true })
  }
  function expand() {
    if (sbEl) sbEl.classList.remove('collapsed')
  }
  function userExpand() {
    expand()
    userSetCollapse = true
    storageSet({ sidebarCollapsed: false })
  }

  // ---- mount -----------------------------------------------------------------
  function mount() {
    if (document.getElementById(HOST_ID)) return
    var host = document.createElement('div')
    host.id = HOST_ID
    // 0x0 anchor; the fixed-position sidebar/tab escape it and sit above the page.
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;'
    ;(document.body || document.documentElement).appendChild(host)

    root = host.attachShadow({ mode: 'open' })
    root.innerHTML = shellHTML()

    sbEl = $('sb')
    applyView = $('view-apply')
    chipEl = $('chip'); chipText = $('chipText')

    // nav
    var nav = $('nav')
    if (nav) nav.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null
      if (!b) return
      switchView(b.getAttribute('data-view'))
    })

    // collapse / tab
    var cb = $('collapseBtn'); if (cb) cb.addEventListener('click', collapse)
    var tab = $('tab'); if (tab) tab.addEventListener('click', userExpand)

    // apply commands
    var fillBtn = $('fillBtn'); if (fillBtn) fillBtn.addEventListener('click', function () {
      if (readyFields.length === 0) return
      // Show progress + lock the view immediately, before autofill's fill events
      // (and the re-detect they trigger) can race the UI.
      enterFilling()
      cmd('startFill')
    })
    var stopBtn = $('stopBtn'); if (stopBtn) stopBtn.addEventListener('click', function () { cmd('stopFill') })
    var cvBtn = $('cvBtn'); if (cvBtn) cvBtn.addEventListener('click', function () { cmd('attachCv') })
    var ctxChange = $('ctxChange'); if (ctxChange) ctxChange.addEventListener('click', function () { switchView('cvs') })

    // restore collapse preference; else start collapsed (slim tab) until a form
    // is detected, at which point onReady auto-expands.
    storageGet('sidebarCollapsed', function (o) {
      if (o && typeof o.sidebarCollapsed === 'boolean') {
        userSetCollapse = true
        if (o.sidebarCollapsed) collapseSilent(); else expand()
      } else {
        collapseSilent() // default: tab only, non-intrusive
      }
    })

    // subscribe to the shared bus
    bindBus({
      ctx: onCtx,
      detecting: onDetecting,
      ready: onReady,
      empty: onEmpty,
      progress: onProgress,
      filled: onFilled,
      attach: onAttach,
      done: onDone,
      error: onError,
    })

    // fallback context (in case ctx fired before we subscribed)
    primeContextFallback()
  }

  function collapseSilent() { if (sbEl) sbEl.classList.add('collapsed') }

  // Mount: resolve the user's app locale (from their cached profile in the SW)
  // BEFORE building the shell, so the chrome renders in the user's language, not
  // the ATS page's <html lang>. Never block more than 500ms on it. Runs at most
  // once; safe to call from any lazy-mount trigger.
  var _mounted = false
  function doMount() {
    if (_mounted) return
    _mounted = true
    clearLazyTriggers()
    var built = false
    function build() {
      if (built) return
      built = true
      mount()
      // The apply layer may have already reached a terminal state (autofill
      // detected + emitted 'ready'/'error' before we mounted). Bus emits are not
      // replayed on subscribe, so pull the last state explicitly.
      replayBusState()
    }
    var timer = setTimeout(build, 500)
    send({ type: 'GET_PROFILE' }, function (resp) {
      if (resp && resp.locale) lang = pickLang(resp.locale)
      clearTimeout(timer)
      build()
      // If the 500ms timer mounted the shell in the fallback lang before this
      // resolved, re-apply every static string in the resolved language.
      relocalize()
    })
  }

  function replayBusState() {
    var b = bus()
    if (!b || typeof b.last !== 'function') return
    var ready = b.last('ready')
    if (ready) { try { onReady(ready) } catch (e) {} return }
    var err = b.last('error')
    if (err) { try { onError(err) } catch (e) {} }
  }

  // ---- gated lazy mount ------------------------------------------------------
  // Broad injection means this script loads on every page. It must render
  // NOTHING until the page looks like a job application. On a plain page it does
  // a cheap gate check and returns; it then only reacts to SPA navigation and to
  // the apply bus (which autofill drives, and only when it too judges the page a
  // job application). No host/shadow is created until the gate passes.
  function isLikelyJob() {
    var b = bus()
    return !!(b && typeof b.isLikelyJobApplication === 'function' && b.isLikelyJobApplication())
  }

  function maybeMount() {
    if (_mounted) return
    if (!isLikelyJob()) return
    doMount()
  }

  var lazyOffs = []
  function clearLazyTriggers() {
    for (var i = 0; i < lazyOffs.length; i++) { try { lazyOffs[i]() } catch (e) {} }
    lazyOffs = []
    window.removeEventListener('popstate', maybeMount)
  }

  function armLazyMount() {
    var b = bus()
    if (b && typeof b.on === 'function') {
      // autofill emits these ONLY when it considers the page an application, so
      // any of them is a valid trigger to mount lazily.
      lazyOffs.push(b.on('detecting', maybeMount))
      lazyOffs.push(b.on('ready', maybeMount))
      lazyOffs.push(b.on('error', maybeMount))
      lazyOffs.push(b.on('empty', maybeMount))
    }
    // SPA navigation into an application (URL change) re-checks the gate. Cheap
    // event listeners, never an observer, so a non-job page stays inert.
    var origPush = history.pushState
    history.pushState = function () {
      var ret = origPush.apply(this, arguments)
      maybeMount()
      return ret
    }
    window.addEventListener('popstate', maybeMount)
  }

  function boot() {
    // The gate reads the DOM; give apply-shared a beat to initialize the bus and
    // let document_idle settle, matching autofill/cv-attach boot timing.
    if (isLikelyJob()) { doMount(); return }
    armLazyMount()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
