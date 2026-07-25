/**
 * JobSwiper - side panel (Shadow-DOM, single surface).
 *
 * Injected once per top frame. It answers ONE question: what can the user do on
 * this page, right now. Three page contexts, plus an account gate:
 *
 *   offer  - a readable job listing, no application form: match score + gaps.
 *   apply  - an application form: the values about to be written, what is left
 *            to the user, the form's own questions.
 *   none   - anything else: nothing to fill, save the page, resume recent jobs.
 *   gate   - signed out or unusable profile: one message, one action.
 *
 * Wiring (INTEGRATION CONTRACT):
 *   - Subscribes to the shared bus on window.__jobswiperApply:
 *       ctx / detecting / ready / empty / progress / filled / attach / done /
 *       error / answer / coverletter
 *   - Drives the flow via the shared commands:
 *       startFill() / stopFill() / attachCv() / selectCv(id) / draftAnswer(i) /
 *       generateCoverLetter()
 *   - apply-shared.js initializes the bus (loaded first). If this script loads
 *     first, it retries binding until on/emit exist (bounded), and guards with a
 *     no-op fallback so it never throws.
 *
 * It NEVER touches the page's form and NEVER fetches: form logic lives in
 * autofill.js / cv-attach.js, authenticated fetches live in the service worker.
 */
;(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__jobswiperSidebarLoaded) return
  window.__jobswiperSidebarLoaded = true

  var API_BASE = 'https://www.jobswiper.ai'
  var HOST_ID = 'jobswiper-apply-sidebar-host'
  var PANEL_W = 380 // single source of truth: panel width AND page squeeze

  // ---- chrome guards ---------------------------------------------------------
  function hasRuntime() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id) } catch (e) { return false }
  }
  function send(msg, cb) {
    if (!hasRuntime()) { if (cb) cb(null); return }
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
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
  function assetUrl(path) {
    try {
      if (chrome && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(path)
    } catch (e) { /* noop */ }
    return ''
  }

  // Font faces are document-scoped: a @font-face inside a shadow root is ignored
  // by Chrome. Register it on the document under a namespaced family so a host
  // page shipping its own Nunito is never affected.
  function loadFont() {
    try {
      var url = assetUrl('fonts/nunito-latin.woff2')
      if (!url || typeof FontFace === 'undefined' || !document.fonts) return
      var ff = new FontFace('JobSwiperNunito', 'url(' + url + ')', { weight: '400 900', display: 'swap' })
      ff.load().then(function (f) { try { document.fonts.add(f) } catch (e) { /* noop */ } })
        .catch(function () { /* falls back to the system stack */ })
    } catch (e) { /* noop */ }
  }

  // ---- i18n ------------------------------------------------------------------
  var I18N = {
    en: {
      panelLabel: 'JobSwiper panel', collapse: 'Close the panel',
      widgetMenu: 'Panel options', hideUntilVisit: 'Hide until next visit',
      disableDomain: 'Turn off on this site', disableAll: 'Turn off everywhere',
      nav: { page: 'This page', jobs: 'My jobs', me: 'Me' },
      whereOffer: 'Job offer', whereApply: 'Application',
      loading: 'Reading this page...',
      // offer
      analyzing: 'Checking your match...',
      tiers: { strong: 'Strong match', good: 'Good match', possible: 'Partial match', low: 'Weak match' },
      mustHaves: function (a, b) { return a + ' of ' + b + ' must-haves met' },
      reasonSeniority: 'Seniority gap for this role',
      reasonEducation: 'Education requirement not met',
      reasonExperience: 'Experience in a similar role',
      coldStart: 'Complete your profile to get a real match score.',
      missing: 'What is missing', have: 'What you already have',
      quotedFrom: 'Quoted from the offer, missing from your profile',
      offerSave: 'Save this offer', offerSaved: 'Saved', offerAlready: 'Already in your jobs',
      offerTailor: 'Create a CV for this offer',
      offerNoScore: 'Complete your profile to see how you match this offer.',
      offerError: 'Could not check this offer. Reopen the panel to try again.',
      scoreFallback: 'Rough estimate: this offer has not been fully analyzed yet.',
      // apply
      change: 'Change', willWrite: 'What will be written', written: 'Written into the form',
      fillBtn: function (n) { return n === 1 ? 'Fill 1 field' : 'Fill the ' + n + ' fields' },
      filling: function (i, n) { return 'Filling ' + i + ' of ' + n }, stop: 'Stop',
      filled: function (n) { return n === 1 ? '1 field filled' : n + ' fields filled' },
      reviewThem: 'Read them over, then submit the form yourself.',
      seeDetail: 'See detail', hideDetail: 'Hide',
      yours: 'This stays yours', tagRequired: 'Required', tagSensitive: 'Sensitive', jump: 'Go',
      sensitiveWhy: 'JobSwiper never fills sensitive fields for you.',
      questions: "The form's questions", clLabel: 'Cover letter',
      draft: 'Draft', redraft: 'Redo', drafting: 'Writing...',
      drafted: 'Written, read it before you submit', draftFailed: 'Could not write it. Try again.',
      aiLimit: 'AI limit reached. Upgrade on JobSwiper.',
      attachCta: 'Attach the CV', attaching: 'Attaching...',
      attached: function (n) { return n + ' attached' }, attachFailed: 'Could not attach the CV.',
      submitYours: 'Submitting the form stays yours.',
      noFields: 'Nothing to fill on this form yet.',
      // none
      noneTitle: 'No job offer on this page',
      noneBody: 'Open a job offer or an application form: JobSwiper will show your match and offer to fill it in.',
      saveAnyway: 'Save this page anyway', saving: 'Saving...',
      saveNotJob: 'This page does not look like a job offer.',
      savedJob: function (t) { return t ? 'Saved: ' + t : 'Saved' }, saveFailed: 'Could not save. Try again.',
      resume: 'Pick up where you left off',
      // gate
      gateSignIn: 'Sign in to fill this form',
      gateSignInBody: function (n, q) {
        var bits = n + (n === 1 ? ' field' : ' fields')
        if (q) bits += ' and ' + q + (q === 1 ? ' question' : ' questions')
        return 'JobSwiper spotted ' + bits + ' on this page. Sign in to fill them with your profile.'
      },
      gateSignInPlain: 'Sign in to use JobSwiper on this page.',
      gateSignInBtn: 'Sign in to JobSwiper',
      gateProfile: 'Complete your profile first',
      gateProfileBody: 'JobSwiper fills forms from your profile. Add your details once, then every application takes one click.',
      gateProfileBtn: 'Complete my profile',
      // jobs
      jobsLabel: 'Your recent jobs', jobsEmpty: 'Nothing saved yet.',
      viewPipeline: 'Open the full pipeline',
      statusApplied: 'Applied', statusInterview: 'Interview', statusDraft: 'Draft', statusSaved: 'Saved',
      // me
      profileLabel: 'Your profile', completeness: 'Profile completed',
      profileEmpty: 'No profile yet.', signIn: 'Sign in',
      cvsLabel: 'Your CVs', cvsEmpty: 'No CV yet.', use: 'Use', active: 'In use',
      newCv: 'Create a CV', editProfile: 'Edit my profile',
      accountLabel: 'Account', managePlan: 'Manage my plan', signOut: 'Sign out of the extension',
      signOutNote: 'Signs out the extension only, not the website.',
      pf: {
        full_name: 'Name', email: 'E-mail', phone: 'Phone', city: 'City',
        current_company: 'Company', headline: 'Headline', linkedin_url: 'LinkedIn', website: 'Website',
      },
    },
    fr: {
      panelLabel: 'Panneau JobSwiper', collapse: 'Fermer le panneau',
      widgetMenu: 'Options du panneau', hideUntilVisit: 'Masquer jusqu’à la prochaine visite',
      disableDomain: 'Désactiver sur ce site', disableAll: 'Désactiver partout',
      nav: { page: 'Cette page', jobs: 'Mes offres', me: 'Moi' },
      whereOffer: 'Offre d’emploi', whereApply: 'Candidature',
      loading: 'Lecture de la page...',
      analyzing: 'Analyse de ton match...',
      tiers: { strong: 'Très bon match', good: 'Bon match', possible: 'Match partiel', low: 'Match faible' },
      mustHaves: function (a, b) { return a + ' critères essentiels sur ' + b },
      reasonSeniority: 'Écart de séniorité sur ce poste',
      reasonEducation: 'Niveau d’études non atteint',
      reasonExperience: 'Expérience sur un poste similaire',
      coldStart: 'Complète ton profil pour obtenir un vrai score de match.',
      missing: 'Ce qui manque', have: 'Ce que tu as déjà',
      quotedFrom: 'Cité de l’annonce, absent de ton profil',
      offerSave: 'Sauvegarder cette offre', offerSaved: 'Sauvegardée', offerAlready: 'Déjà dans tes offres',
      offerTailor: 'Créer un CV pour cette offre',
      offerNoScore: 'Complète ton profil pour voir ton match sur cette offre.',
      offerError: 'Impossible d’analyser cette offre. Rouvre le panneau pour réessayer.',
      scoreFallback: 'Estimation approximative : cette offre n’a pas encore été analysée en détail.',
      change: 'Changer', willWrite: 'Ce qui va être écrit', written: 'Écrit dans le formulaire',
      fillBtn: function (n) { return n === 1 ? 'Remplir 1 champ' : 'Remplir les ' + n + ' champs' },
      filling: function (i, n) { return 'Remplissage ' + i + ' sur ' + n }, stop: 'Arrêter',
      filled: function (n) { return n === 1 ? '1 champ rempli' : n + ' champs remplis' },
      reviewThem: 'Relis-les, puis envoie le formulaire toi-même.',
      seeDetail: 'Voir le détail', hideDetail: 'Masquer',
      yours: 'Ça reste à toi', tagRequired: 'Obligatoire', tagSensitive: 'Sensible', jump: 'Aller',
      sensitiveWhy: 'JobSwiper ne remplit jamais les champs sensibles à ta place.',
      questions: 'Questions du formulaire', clLabel: 'Lettre de motivation',
      draft: 'Rédiger', redraft: 'Refaire', drafting: 'Rédaction...',
      drafted: 'Rédigé, relis avant d’envoyer', draftFailed: 'Rédaction impossible. Réessaie.',
      aiLimit: 'Limite IA atteinte. Passe à la version supérieure sur JobSwiper.',
      attachCta: 'Joindre le CV', attaching: 'Ajout en cours...',
      attached: function (n) { return n + ' joint' }, attachFailed: 'Impossible de joindre le CV.',
      submitYours: 'L’envoi du formulaire reste à toi.',
      noFields: 'Rien à remplir sur ce formulaire pour l’instant.',
      noneTitle: 'Aucune offre sur cette page',
      noneBody: 'Ouvre une annonce ou un formulaire de candidature : JobSwiper affichera ton match et proposera de le remplir.',
      saveAnyway: 'Sauvegarder cette page quand même', saving: 'Enregistrement...',
      saveNotJob: 'Cette page ne ressemble pas à une offre d’emploi.',
      savedJob: function (t) { return t ? 'Sauvegardée : ' + t : 'Sauvegardée' }, saveFailed: 'Échec de l’enregistrement. Réessaie.',
      resume: 'Reprendre où tu en étais',
      gateSignIn: 'Connecte-toi pour remplir ce formulaire',
      gateSignInBody: function (n, q) {
        var bits = n + (n === 1 ? ' champ' : ' champs')
        if (q) bits += ' et ' + q + (q === 1 ? ' question' : ' questions')
        return 'JobSwiper a repéré ' + bits + ' sur cette page. Connecte-toi pour les remplir avec ton profil.'
      },
      gateSignInPlain: 'Connecte-toi pour utiliser JobSwiper sur cette page.',
      gateSignInBtn: 'Se connecter à JobSwiper',
      gateProfile: 'Complète d’abord ton profil',
      gateProfileBody: 'JobSwiper remplit les formulaires depuis ton profil. Renseigne-le une fois, et chaque candidature tient en un clic.',
      gateProfileBtn: 'Compléter mon profil',
      jobsLabel: 'Tes offres récentes', jobsEmpty: 'Rien de sauvegardé pour l’instant.',
      viewPipeline: 'Ouvrir le pipeline complet',
      statusApplied: 'Postulé', statusInterview: 'Entretien', statusDraft: 'Brouillon', statusSaved: 'Sauvegardée',
      profileLabel: 'Ton profil', completeness: 'Profil complété',
      profileEmpty: 'Pas encore de profil.', signIn: 'Se connecter',
      cvsLabel: 'Tes CV', cvsEmpty: 'Pas encore de CV.', use: 'Utiliser', active: 'Utilisé',
      newCv: 'Créer un CV', editProfile: 'Modifier mon profil',
      accountLabel: 'Compte', managePlan: 'Gérer mon abonnement', signOut: 'Déconnecter l’extension',
      signOutNote: 'Déconnecte l’extension seulement, pas le site.',
      pf: {
        full_name: 'Nom', email: 'E-mail', phone: 'Téléphone', city: 'Ville',
        current_company: 'Entreprise', headline: 'Titre', linkedin_url: 'LinkedIn', website: 'Site web',
      },
    },
    es: {
      panelLabel: 'Panel JobSwiper', collapse: 'Cerrar el panel',
      widgetMenu: 'Opciones del panel', hideUntilVisit: 'Ocultar hasta la próxima visita',
      disableDomain: 'Desactivar en este sitio', disableAll: 'Desactivar en todas partes',
      nav: { page: 'Esta página', jobs: 'Mis ofertas', me: 'Yo' },
      whereOffer: 'Oferta de empleo', whereApply: 'Candidatura',
      loading: 'Leyendo la página...',
      analyzing: 'Analizando tu match...',
      tiers: { strong: 'Match muy bueno', good: 'Buen match', possible: 'Match parcial', low: 'Match bajo' },
      mustHaves: function (a, b) { return a + ' requisitos imprescindibles de ' + b },
      reasonSeniority: 'Diferencia de senioridad para este puesto',
      reasonEducation: 'Nivel de estudios no alcanzado',
      reasonExperience: 'Experiencia en un puesto similar',
      coldStart: 'Completa tu perfil para obtener un match real.',
      missing: 'Lo que falta', have: 'Lo que ya tienes',
      quotedFrom: 'Citado de la oferta, ausente de tu perfil',
      offerSave: 'Guardar esta oferta', offerSaved: 'Guardada', offerAlready: 'Ya está en tus ofertas',
      offerTailor: 'Crear un CV para esta oferta',
      offerNoScore: 'Completa tu perfil para ver tu match con esta oferta.',
      offerError: 'No se pudo analizar esta oferta. Vuelve a abrir el panel para reintentar.',
      scoreFallback: 'Estimación aproximada: esta oferta aún no se ha analizado en detalle.',
      change: 'Cambiar', willWrite: 'Lo que se va a escribir', written: 'Escrito en el formulario',
      fillBtn: function (n) { return n === 1 ? 'Rellenar 1 campo' : 'Rellenar los ' + n + ' campos' },
      filling: function (i, n) { return 'Rellenando ' + i + ' de ' + n }, stop: 'Parar',
      filled: function (n) { return n === 1 ? '1 campo rellenado' : n + ' campos rellenados' },
      reviewThem: 'Revísalos y envía el formulario tú mismo.',
      seeDetail: 'Ver el detalle', hideDetail: 'Ocultar',
      yours: 'Esto queda para ti', tagRequired: 'Obligatorio', tagSensitive: 'Sensible', jump: 'Ir',
      sensitiveWhy: 'JobSwiper nunca rellena campos sensibles por ti.',
      questions: 'Preguntas del formulario', clLabel: 'Carta de motivación',
      draft: 'Redactar', redraft: 'Rehacer', drafting: 'Redactando...',
      drafted: 'Redactado, revísalo antes de enviar', draftFailed: 'No se pudo redactar. Reintenta.',
      aiLimit: 'Límite de IA alcanzado. Mejora tu plan en JobSwiper.',
      attachCta: 'Adjuntar el CV', attaching: 'Adjuntando...',
      attached: function (n) { return n + ' adjuntado' }, attachFailed: 'No se pudo adjuntar el CV.',
      submitYours: 'El envío del formulario queda para ti.',
      noFields: 'Nada que rellenar en este formulario por ahora.',
      noneTitle: 'No hay ninguna oferta en esta página',
      noneBody: 'Abre una oferta o un formulario de candidatura: JobSwiper mostrará tu match y propondrá rellenarlo.',
      saveAnyway: 'Guardar esta página de todos modos', saving: 'Guardando...',
      saveNotJob: 'Esta página no parece una oferta de empleo.',
      savedJob: function (t) { return t ? 'Guardada: ' + t : 'Guardada' }, saveFailed: 'No se pudo guardar. Reintenta.',
      resume: 'Retoma donde lo dejaste',
      gateSignIn: 'Inicia sesión para rellenar este formulario',
      gateSignInBody: function (n, q) {
        var bits = n + (n === 1 ? ' campo' : ' campos')
        if (q) bits += ' y ' + q + (q === 1 ? ' pregunta' : ' preguntas')
        return 'JobSwiper ha detectado ' + bits + ' en esta página. Inicia sesión para rellenarlos con tu perfil.'
      },
      gateSignInPlain: 'Inicia sesión para usar JobSwiper en esta página.',
      gateSignInBtn: 'Iniciar sesión en JobSwiper',
      gateProfile: 'Completa primero tu perfil',
      gateProfileBody: 'JobSwiper rellena los formularios desde tu perfil. Complétalo una vez y cada candidatura será un clic.',
      gateProfileBtn: 'Completar mi perfil',
      jobsLabel: 'Tus ofertas recientes', jobsEmpty: 'Nada guardado por ahora.',
      viewPipeline: 'Abrir el pipeline completo',
      statusApplied: 'Postulado', statusInterview: 'Entrevista', statusDraft: 'Borrador', statusSaved: 'Guardada',
      profileLabel: 'Tu perfil', completeness: 'Perfil completado',
      profileEmpty: 'Aún no hay perfil.', signIn: 'Iniciar sesión',
      cvsLabel: 'Tus CV', cvsEmpty: 'Aún no hay CV.', use: 'Usar', active: 'En uso',
      newCv: 'Crear un CV', editProfile: 'Editar mi perfil',
      accountLabel: 'Cuenta', managePlan: 'Gestionar mi plan', signOut: 'Cerrar sesión de la extensión',
      signOutNote: 'Cierra la sesión de la extensión, no la del sitio.',
      pf: {
        full_name: 'Nombre', email: 'Correo', phone: 'Teléfono', city: 'Ciudad',
        current_company: 'Empresa', headline: 'Titular', linkedin_url: 'LinkedIn', website: 'Sitio web',
      },
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
    if (!b) return
    // Prefer command(): in the top frame it routes to the child ATS frame that
    // owns the form (iframe bridge), and falls back to the direct local command.
    if (typeof b.command === 'function') { try { b.command(name, arg) } catch (e) { /* noop */ } return }
    if (typeof b[name] === 'function') { try { b[name](arg) } catch (e) { /* noop */ } }
  }
  var busOffs = []
  function bindBus(handlers) {
    var tries = 0
    ;(function tryBind() {
      var b = bus()
      if (b && typeof b.on === 'function') {
        Object.keys(handlers).forEach(function (evt) { busOffs.push(b.on(evt, handlers[evt])) })
        return
      }
      if (tries++ < 40) setTimeout(tryBind, 50) // ~2s max
    })()
  }
  function unbindBus() {
    for (var i = 0; i < busOffs.length; i++) { try { busOffs[i]() } catch (e) { /* noop */ } }
    busOffs = []
  }

  // ---- styles ----------------------------------------------------------------
  var CSS = [
    ':host{',
    '--ink:#101014;--muted:#5f5f68;--faint:#9695a0;',
    '--line:#e6e6ea;--line-soft:#f0f0f3;--sunk:#f7f7f9;--surface:#fff;',
    '--blue:#0064be;--blue-ink:#004f97;--blue-wash:#eaf2fb;',
    '--ok:#047857;--ok-wash:#e9f6f0;--warn:#a35a09;--warn-wash:#fbf1e4;--bad:#c0271f;--bad-wash:#fbecea;',
    '--r1:8px;',
    'all:initial;font-family:"JobSwiperNunito",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
    '}',
    '@media (prefers-color-scheme: dark){:host{',
    '--ink:#f3f3f5;--muted:#a5a5ae;--faint:#7d7d87;',
    '--line:#2b2d33;--line-soft:#232529;--sunk:#1e2024;--surface:#17181c;',
    '--blue:#5aa3ea;--blue-ink:#7cb8f2;--blue-wash:rgba(90,163,234,.15);',
    '--ok:#34d399;--ok-wash:rgba(52,211,153,.14);--warn:#e0975a;--warn-wash:rgba(224,151,90,.15);',
    '--bad:#f87171;--bad-wash:rgba(248,113,113,.15);',
    '}}',
    '*{margin:0;padding:0;box-sizing:border-box;}',
    // The shadow host carries an inline `all:initial` (page-style isolation),
    // which outranks the :host rule above and would reset the family back to the
    // browser default. Set it again on every root the shadow tree actually
    // renders, where nothing inline can beat it.
    '.sb,.widget,.w-menu{font-family:"JobSwiperNunito",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}',
    'button,input{font-family:inherit;}',

    // shell: flush against the viewport edge, full height, no radius, no float
    '.sb{position:fixed;top:0;right:0;bottom:0;width:' + PANEL_W + 'px;max-width:100vw;',
    'background:var(--surface);border-left:1px solid var(--line);color:var(--ink);',
    'display:flex;flex-direction:column;overflow:hidden;font-size:13px;line-height:1.45;',
    '-webkit-font-smoothing:antialiased;transition:transform .26s cubic-bezier(.4,0,.2,1);',
    'z-index:2147483000;}',
    '.sb.collapsed{transform:translateX(' + (PANEL_W + 4) + 'px);}',

    // header
    '.head{display:flex;align-items:center;gap:8px;padding:0 14px;height:48px;flex:none;border-bottom:1px solid var(--line-soft);}',
    '.head img{width:18px;height:18px;border-radius:4px;display:block;}',
    '.mark{font-weight:800;font-size:14px;letter-spacing:-.015em;}',
    '.mark i{color:var(--blue);font-style:normal;}',
    '.head .x{margin-left:auto;width:26px;height:26px;border:none;background:none;display:grid;place-items:center;',
    'border-radius:6px;color:var(--faint);cursor:pointer;}',
    '.head .x:hover{background:var(--sunk);color:var(--ink);}',
    '.head .x svg{width:15px;height:15px;}',

    '.scroll{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}',
    '.body{padding:14px;display:flex;flex-direction:column;gap:16px;flex:1;}',
    '.body.mid{padding-top:46px;gap:14px;}',
    '.blk{min-width:0;}',

    '.where{font-size:11.5px;font-weight:700;color:var(--faint);}',
    '.job{margin-top:6px;}',
    '.job h1{font-size:15.5px;font-weight:800;line-height:1.28;letter-spacing:-.01em;}',
    '.job p{font-size:12.5px;font-weight:600;color:var(--muted);margin-top:2px;}',
    '.lbl{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin-bottom:7px;}',
    '.note{font-size:12.5px;font-weight:600;color:var(--muted);line-height:1.55;}',
    '.mini{font-size:11.5px;font-weight:700;color:var(--faint);}',

    // score
    '.score{display:flex;align-items:baseline;gap:8px;}',
    '.score b{font-size:31px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.02em;}',
    '.score span{font-size:13px;font-weight:800;}',
    '.score em{margin-left:auto;font-style:normal;font-size:11.5px;font-weight:700;color:var(--faint);}',
    '.bar{height:5px;border-radius:3px;background:var(--line-soft);overflow:hidden;margin-top:9px;}',
    '.bar > i{display:block;height:100%;border-radius:3px;transition:width .3s ease;}',
    '.t-strong b,.t-strong span{color:var(--ok);}.t-strong .bar>i{background:var(--ok);}',
    '.t-good b,.t-good span{color:var(--blue);}.t-good .bar>i{background:var(--blue);}',
    '.t-possible b,.t-possible span{color:var(--warn);}.t-possible .bar>i{background:var(--warn);}',
    '.t-low b,.t-low span{color:var(--bad);}.t-low .bar>i{background:var(--bad);}',
    '.quote{font-size:12.5px;font-weight:700;line-height:1.5;}',
    '.src{font-size:11px;font-weight:700;color:var(--faint);margin-top:4px;}',

    '.chips{display:flex;flex-wrap:wrap;gap:5px;}',
    '.chip{font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:999px;max-width:100%;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.chip.gap{background:var(--warn-wash);color:var(--warn);}',
    '.chip.have{background:var(--ok-wash);color:var(--ok);}',

    // cv line
    '.cv{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:700;}',
    '.cv .doc{width:15px;height:15px;color:var(--blue);flex:none;}',
    '.cv .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
    '.cv .act-link{margin-left:auto;flex:none;color:var(--blue);font-weight:800;font-size:12px;',
    'background:none;border:none;cursor:pointer;padding:0;}',
    '.cv .act-link:hover{text-decoration:underline;}',
    '.cv .tk{margin-left:auto;flex:none;color:var(--ok);font-weight:800;}',

    // field list (label + the value that will be written)
    '.fields{display:flex;flex-direction:column;}',
    '.f{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--line-soft);align-items:baseline;}',
    '.f:first-child{border-top:none;}',
    '.f .k{flex:0 0 33%;font-size:11.5px;font-weight:700;color:var(--muted);}',
    '.f .v{flex:1;font-size:12.5px;font-weight:700;word-break:break-word;min-width:0;}',
    '.f .s{flex:none;width:14px;text-align:right;font-size:12px;font-weight:800;color:var(--ok);}',

    // fold (post-fill summary)
    '.fold{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;border:none;',
    'background:none;font-family:inherit;cursor:pointer;padding:0;text-align:left;color:inherit;}',
    '.fold .tk{width:17px;height:17px;border-radius:50%;background:var(--ok);color:#fff;display:grid;place-items:center;flex:none;}',
    '.fold .tk svg{width:10px;height:10px;}',
    '.fold b{font-size:13px;font-weight:800;}',
    '.fold .more{margin-left:auto;font-size:11.5px;font-weight:800;color:var(--blue);display:flex;align-items:center;gap:3px;}',
    '.fold .more svg{width:12px;height:12px;transition:transform .18s ease;}',
    '.fold.open .more svg{transform:rotate(180deg);}',
    '.sub{font-size:12.5px;font-weight:600;color:var(--muted);margin-top:4px;}',

    // progress
    '.prog{height:5px;border-radius:3px;background:var(--line-soft);overflow:hidden;margin-top:9px;}',
    '.prog > i{display:block;height:100%;width:0;background:var(--blue);border-radius:3px;transition:width .3s ease;}',
    '.prog-meta{display:flex;justify-content:space-between;align-items:baseline;font-size:11.5px;font-weight:700;',
    'color:var(--muted);margin-top:6px;font-variant-numeric:tabular-nums;}',
    '.prog-meta button{border:none;background:none;font-family:inherit;font-size:11.5px;font-weight:800;',
    'color:var(--bad);cursor:pointer;padding:0;}',

    // "this stays yours"
    '.you{display:flex;flex-direction:column;}',
    '.y{display:flex;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--line-soft);}',
    '.y:first-child{border-top:none;}',
    '.y .n{flex:1;min-width:0;font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.tag{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:999px;flex:none;}',
    '.tag.req{background:var(--warn-wash);color:var(--warn);}',
    '.tag.sens{background:var(--sunk);color:var(--muted);}',
    '.y button.go{flex:none;border:none;background:none;color:var(--blue);font-family:inherit;font-weight:800;',
    'font-size:11.5px;cursor:pointer;padding:0;}',
    '.y button.go:hover{text-decoration:underline;}',

    // questions
    '.q{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid var(--line-soft);}',
    '.q:first-child{border-top:none;}',
    '.q .txt{flex:1;min-width:0;font-size:12.5px;font-weight:600;line-height:1.4;}',
    '.q .st{display:block;font-size:11.5px;font-weight:700;margin-top:3px;color:var(--muted);}',
    '.q .st.ok{color:var(--ok);}',
    '.q .st.err{color:var(--bad);}',
    '.btn-s{flex:none;border:1px solid var(--line);background:var(--surface);color:var(--blue);font-family:inherit;',
    'font-weight:800;font-size:11.5px;padding:5px 10px;border-radius:var(--r1);cursor:pointer;min-width:62px;',
    'display:inline-flex;align-items:center;justify-content:center;gap:5px;}',
    '.btn-s:hover{background:var(--blue-wash);border-color:var(--blue-wash);}',
    '.btn-s:disabled{opacity:.55;cursor:default;}',
    '.spin{width:11px;height:11px;border:2px solid var(--line);border-top-color:var(--blue);border-radius:50%;',
    'animation:jsw-rot .6s linear infinite;flex:none;display:inline-block;}',
    '@keyframes jsw-rot{to{transform:rotate(360deg)}}',
    '.loading{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600;color:var(--muted);}',

    // rows (jobs, cvs)
    '.rows{display:flex;flex-direction:column;}',
    '.r{display:flex;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line-soft);',
    'background:none;border-left:none;border-right:none;border-bottom:none;width:100%;text-align:left;',
    'font-family:inherit;color:inherit;cursor:pointer;}',
    '.r:first-child{border-top:none;}',
    '.r:hover .m b{color:var(--blue);}',
    '.r .m{flex:1;min-width:0;}',
    '.r .m b{display:block;font-size:12.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.r .m span{display:block;font-size:11.5px;font-weight:600;color:var(--muted);margin-top:1px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.r .st{flex:none;font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:999px;background:var(--sunk);color:var(--muted);}',
    '.r .st.app{background:var(--blue-wash);color:var(--blue-ink);}',
    '.r .st.itw{background:var(--ok-wash);color:var(--ok);}',
    '.r .st.on{background:var(--blue);color:#fff;}',
    '.r .chev{flex:none;width:13px;height:13px;color:var(--faint);}',

    // meter (profile completeness)
    '.meter{height:5px;border-radius:3px;background:var(--line-soft);overflow:hidden;margin-top:7px;}',
    '.meter > i{display:block;height:100%;border-radius:3px;}',
    '.kv{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line-soft);font-size:12.5px;}',
    '.kv:first-of-type{border-top:none;}',
    '.kv .k{color:var(--muted);font-weight:700;flex:none;}',
    '.kv .v{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;}',

    '.empty h2{font-size:14.5px;font-weight:800;line-height:1.35;}',
    '.empty p{font-size:12.5px;font-weight:600;color:var(--muted);margin-top:6px;line-height:1.55;}',

    // action bar
    '.act{position:sticky;bottom:0;background:var(--surface);display:flex;flex-direction:column;gap:8px;padding:12px 14px 14px;}',
    '.act:empty{display:none;}',
    '.act.floats{box-shadow:0 -12px 14px -12px rgba(16,16,20,.18);}',
    '.btn{border:none;border-radius:var(--r1);font-family:inherit;font-weight:800;font-size:13px;padding:11px;',
    'cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;text-decoration:none;width:100%;}',
    '.btn svg{width:15px;height:15px;flex:none;}',
    '.btn-p{background:var(--blue);color:#fff;}',
    '.btn-p:hover{background:var(--blue-ink);}',
    '.btn-p:disabled{opacity:.55;cursor:default;}',
    '.btn-g{background:var(--surface);color:var(--ink);border:1px solid var(--line);}',
    '.btn-g:hover{background:var(--sunk);}',
    '.btn.inline{width:auto;align-self:flex-start;}',
    '.foot{font-size:11.5px;font-weight:700;color:var(--faint);text-align:center;}',
    '.foot.left{text-align:left;}',
    '.status{font-size:12px;font-weight:700;color:var(--muted);}',
    '.status.err{color:var(--bad);}',
    '.status.ok{color:var(--ok);}',

    // nav
    '.nav{flex:none;display:flex;border-top:1px solid var(--line);}',
    '.nav button{flex:1;border:none;background:none;font-family:inherit;cursor:pointer;padding:8px 2px 9px;',
    'display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--faint);font-size:10px;font-weight:800;',
    'white-space:nowrap;overflow:hidden;}',
    '.nav button svg{width:18px;height:18px;}',
    '.nav button.on{color:var(--blue);}',
    '.nav button:hover{color:var(--ink);}',
    '.nav button.on:hover{color:var(--blue);}',

    // floating launcher
    '.widget{position:fixed;right:16px;bottom:80px;z-index:2147483000;display:none;align-items:center;gap:2px;',
    'background:var(--surface);border:1px solid var(--line);border-radius:14px;',
    'box-shadow:0 6px 24px rgba(15,23,42,.12),0 0 0 1px rgba(15,23,42,.04);',
    'padding:5px;cursor:pointer;user-select:none;-webkit-user-select:none;transition:box-shadow .15s;}',
    '.sb.collapsed ~ .widget{display:inline-flex;}',
    '.widget.jsw-hidden{display:none !important;}',
    '.widget.dragging{transition:none;cursor:grabbing;}',
    '.widget:hover{box-shadow:0 12px 34px rgba(15,23,42,.2),0 0 0 1px rgba(15,23,42,.05);}',
    '.w-logo{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;flex:none;pointer-events:none;position:relative;}',
    '.w-logo img{width:26px;height:26px;display:block;}',
    '.w-logo .mono{font-size:12px;font-weight:800;color:var(--blue);}',
    '.w-score{position:absolute;right:-6px;bottom:-4px;min-width:22px;height:17px;padding:0 4px;border-radius:999px;',
    'font-size:10.5px;font-weight:800;color:#fff;display:none;align-items:center;justify-content:center;',
    'font-variant-numeric:tabular-nums;border:2px solid var(--surface);}',
    '.w-score.on{display:flex;}',
    '.w-grip{width:0;opacity:0;overflow:hidden;display:grid;grid-template-columns:repeat(2,4px);grid-auto-rows:4px;gap:3px;',
    'align-content:center;justify-content:center;flex:none;transition:width .15s ease,opacity .12s ease,margin .15s ease;cursor:grab;}',
    '.widget:hover .w-grip{width:15px;opacity:1;margin-right:3px;}',
    '.w-grip span{width:4px;height:4px;border-radius:50%;background:var(--faint);}',
    '.w-close{position:absolute;top:-7px;left:-7px;width:19px;height:19px;border-radius:50%;background:var(--muted);color:#fff;',
    'border:2px solid var(--surface);display:none;place-items:center;cursor:pointer;padding:0;}',
    '.widget:hover .w-close{display:grid;}',
    '.w-close svg{width:9px;height:9px;}',
    '.w-menu{position:fixed;z-index:2147483001;display:none;flex-direction:column;min-width:210px;max-width:calc(100vw - 24px);',
    'background:var(--surface);border:1px solid var(--line);border-radius:12px;',
    'box-shadow:0 6px 24px rgba(15,23,42,.12),0 0 0 1px rgba(15,23,42,.04);padding:5px;}',
    '.w-menu.open{display:flex;}',
    '.w-menu button{text-align:left;border:none;background:none;font-family:inherit;font-size:13px;font-weight:700;',
    'color:var(--ink);padding:10px 11px;border-radius:8px;cursor:pointer;}',
    '.w-menu button:hover{background:var(--sunk);}',

    '@media (prefers-reduced-motion: reduce){*{animation:none !important;transition:none !important;}}',
    '@media (max-width: 560px){.sb{width:100vw;border-left:none;}}',
  ].join('')

  // ---- icons -----------------------------------------------------------------
  var IC = {
    chevronR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
    chevronD: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l4 4L20 5"/></svg>',
    checkFat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l4 4L20 5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    navPage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>',
    navJobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    navMe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  }
  var NAV_ICON = { page: IC.navPage, jobs: IC.navJobs, me: IC.navMe }

  // ---- utils -----------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function clamp01(n) { return Math.max(0, Math.min(100, n)) }
  function hostLabel() {
    try { return (location.hostname || '').replace(/^www\./, '') } catch (e) { return '' }
  }
  // No host (file://, about:blank) must not leave a dangling separator.
  function whereLine(label) {
    var h = hostLabel()
    return h ? label + ' · ' + h : label
  }
  // Same ladder as the app (75/50/30 -> strong/good/possible/low). Only used when
  // the server did not send match_level; its value always wins so the extension
  // and the dashboard can never disagree on a tier.
  function tierOf(score) {
    if (score >= 75) return 'strong'
    if (score >= 50) return 'good'
    if (score >= 30) return 'possible'
    return 'low'
  }
  // The server builds its reason strings in English from the coverage engine.
  // We localize the ones we recognize and drop the rest rather than showing
  // English inside a French or Spanish panel. A verbatim requirement quote keeps
  // the offer's own language, which is exactly why it is quoted.
  var RE_MUSTS = /^(\d+) of (\d+) must-haves met$/
  var RE_MISSING = /^Missing:\s*(.+)$/
  var COLD_START = 'Complete your profile to get a real match score'
  function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim() }

  // ---- component state -------------------------------------------------------
  var root = null, sbEl = null, bodyEl = null, actEl = null, scrollEl = null
  var view = 'page'                 // page | jobs | me
  var ctx = 'loading'               // loading | offer | apply | none | gate
  var gateInfo = null               // { kind, message, href }
  var applyPhase = 'idle'           // idle | filling | filled
  var readyFields = [], readySkipped = [], readyQuestions = [], readyCL = null
  var cvCtx = null                  // { name, tailored } from the ctx bus event
  var filledCount = 0, detailOpen = false
  var qRefs = [], clRef = null, fieldRefs = [], progRef = null, foldRef = null
  var attachState = null            // null | 'attaching' | { name } | 'error'
  var offer = { url: '', loaded: false, job: null, data: null, saved: false, pending: false }
  var recentJobs = null
  var userSetCollapse = false, iconOpenRequested = false
  var fillWatchdog = null, urlWatch = null, lastHref = ''
  var loaded = { jobs: false, me: false }
  var widgetEl = null, wMenuEl = null, dragState = null, dragDocWired = false
  var disabledAll = false, disabledDomains = {}, widgetPos = null
  var HOST = (typeof location !== 'undefined' && location.hostname || '').toLowerCase()
  var _mounted = false

  function $(id) { return root ? root.getElementById(id) : null }

  // ---- context resolution ----------------------------------------------------
  // The page context is DERIVED from the same predicates the apply layer uses, so
  // the panel can never sit on a state nobody drives (the old build-time
  // "detecting" default could hang forever on a job-board page with no form).
  function isApplyPage() {
    var b = bus()
    if (!b) return false
    var direct = typeof b.isLikelyJobApplication === 'function' && b.isLikelyJobApplication()
    var framed = typeof b.hasFrameApply === 'function' && b.hasFrameApply()
    return !!(direct || framed)
  }
  function isRelevant() {
    var b = bus()
    return !!(b && typeof b.isRelevantSite === 'function' && b.isRelevantSite())
  }
  function resolveContext() {
    if (gateInfo) return 'gate'
    if (isApplyPage()) return 'apply'
    if (isRelevant()) return 'offer'
    return 'none'
  }
  function setContext(next, force) {
    if (next === ctx && !force) return
    ctx = next
    if (view === 'page') renderPage()
  }

  // ---- render: shell ---------------------------------------------------------
  function shellHTML() {
    var T = t()
    var logo = assetUrl('icons/icon128.png')
    var headLogo = logo ? '<img src="' + esc(logo) + '" alt="" width="18" height="18">' : ''
    var widgetLogo = logo ? '<img src="' + esc(logo) + '" alt="" width="26" height="26">' : '<span class="mono">JS</span>'
    var navBtns = ['page', 'jobs', 'me'].map(function (v) {
      return '<button data-view="' + v + '"' + (v === 'page' ? ' class="on"' : '') + '>' + NAV_ICON[v] + esc(T.nav[v]) + '</button>'
    }).join('')
    return (
      '<style>' + CSS + '</style>' +
      '<aside class="sb" id="sb" aria-label="' + esc(T.panelLabel) + '">' +
        '<div class="head">' + headLogo +
          '<span class="mark">Job<i>Swiper</i></span>' +
          '<button class="x" id="collapseBtn" title="' + esc(T.collapse) + '" aria-label="' + esc(T.collapse) + '">' + IC.chevronR + '</button>' +
        '</div>' +
        '<div class="scroll" id="scroll">' +
          '<div class="body" id="body" role="region" aria-live="polite"></div>' +
          '<div class="act" id="act"></div>' +
        '</div>' +
        '<nav class="nav" id="nav">' + navBtns + '</nav>' +
      '</aside>' +
      '<div class="widget" id="widget">' +
        '<button class="w-close" id="wClose" title="' + esc(T.widgetMenu) + '" aria-label="' + esc(T.widgetMenu) + '">' + IC.close + '</button>' +
        '<div class="w-logo">' + widgetLogo + '<span class="w-score" id="wScore"></span></div>' +
        '<div class="w-grip" id="wGrip" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></div>' +
      '</div>' +
      '<div class="w-menu" id="wMenu">' +
        '<button data-act="hide">' + esc(T.hideUntilVisit) + '</button>' +
        '<button data-act="domain">' + esc(T.disableDomain) + '</button>' +
        '<button data-act="all">' + esc(T.disableAll) + '</button>' +
      '</div>'
    )
  }

  function setBody(html) { if (bodyEl) bodyEl.innerHTML = html }
  function setAct(html) {
    if (!actEl) return
    actEl.innerHTML = html || ''
    updateActShadow()
  }
  // The action bar only casts a shadow when content actually scrolls under it,
  // so a short screen never fakes hidden content.
  function updateActShadow() {
    if (!actEl || !scrollEl) return
    var scrolls = scrollEl.scrollHeight > scrollEl.clientHeight + 1
    if (scrolls && actEl.innerHTML) actEl.classList.add('floats')
    else actEl.classList.remove('floats')
  }

  function jobHeadHTML(where, title, sub) {
    return '<div class="blk"><div class="where">' + esc(where) + '</div>' +
      (title ? '<div class="job"><h1>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' : '') +
      '</div>'
  }

  // ---- render: page view -----------------------------------------------------
  function renderPage() {
    if (!bodyEl) return
    bodyEl.className = 'body'
    if (ctx === 'gate') return renderGate()
    if (ctx === 'apply') return renderApply()
    if (ctx === 'offer') return renderOffer()
    if (ctx === 'loading') return renderLoading()
    return renderNone()
  }

  function renderLoading() {
    var T = t()
    setBody(jobHeadHTML(hostLabel(), '', '') +
      '<div class="loading"><span class="spin"></span><span>' + esc(T.loading) + '</span></div>')
    setAct('')
  }

  // ---- context: gate ---------------------------------------------------------
  function renderGate() {
    var T = t()
    var profileKind = gateInfo && gateInfo.kind === 'complete'
    var title = profileKind ? T.gateProfile : T.gateSignIn
    var body
    if (profileKind) body = T.gateProfileBody
    else if (readyFields.length) body = T.gateSignInBody(readyFields.length, readyQuestions.length)
    else body = T.gateSignInPlain
    var href = (gateInfo && gateInfo.href) || (API_BASE + (profileKind ? '/dashboard/profile' : '/login'))
    var label = profileKind ? T.gateProfileBtn : T.gateSignInBtn
    bodyEl.className = 'body mid'
    // The action sits right under the sentence it answers, not pinned at the far
    // bottom of an otherwise empty panel.
    setBody('<div class="empty blk"><h2>' + esc(title) + '</h2><p>' + esc(body) + '</p></div>' +
      '<a class="btn btn-p" href="' + esc(href) + '" target="_blank" rel="noreferrer noopener">' + esc(label) + '</a>')
    setAct('')
  }

  // ---- context: offer --------------------------------------------------------
  function scrapeJob(headerOnly) {
    var job = { url: location.href }
    try {
      var h1 = document.querySelector('h1')
      var title = (h1 && h1.textContent) || document.title || ''
      job.title = oneLine(title).slice(0, 200)
    } catch (e) { /* noop */ }
    try {
      var og = document.querySelector('meta[property="og:site_name"]')
      var company = (og && og.getAttribute('content')) || hostLabel().split('.')[0] || ''
      job.company = String(company).slice(0, 120)
    } catch (e) { /* noop */ }
    if (headerOnly) return job
    try {
      if (window.JobSwiperExtract && typeof window.JobSwiperExtract.collectPageText === 'function') {
        job.description = window.JobSwiperExtract.collectPageText(8000) // reads + strips PII
      }
    } catch (e) { /* noop */ }
    return job
  }

  // Title + company for the panel header, cached per URL. Cheap (two selectors),
  // and never pulls the page body: the apply context needs the header only.
  var pageJob = { url: '', title: '', company: '' }
  function jobHeader() {
    if (offer.job && offer.url === location.href) return offer.job
    if (pageJob.url !== location.href) {
      var j = scrapeJob(true)
      pageJob = { url: location.href, title: j.title || '', company: j.company || '' }
    }
    return pageJob
  }

  function renderOffer() {
    var T = t()
    var job = offer.job || {}
    var head = jobHeadHTML(whereLine(T.whereOffer), job.title || '', job.company || '')
    if (offer.pending) {
      setBody(head + '<div class="loading"><span class="spin"></span><span>' + esc(T.analyzing) + '</span></div>')
      setAct('')
      return
    }
    var d = offer.data
    var score = d && typeof d.match_score === 'number' ? Math.round(d.match_score) : null
    if (score == null) {
      var msg = (d === false) ? T.offerError : T.offerNoScore
      setBody(head + '<div class="note blk">' + esc(msg) + '</div>')
      setAct(offerActionsHTML())
      wireOfferActions()
      return
    }

    var reasons = Array.isArray(d.reasons) ? d.reasons : []
    // A cold-start payload reports score 0 with a single "complete your profile"
    // reason. That is not a bad match, it is no match computed at all: never show
    // it as a zero.
    if (reasons.indexOf(COLD_START) !== -1) {
      setBody(head + '<div class="note blk">' + esc(T.coldStart) + '</div>')
      setAct('<a class="btn btn-p" href="' + API_BASE + '/dashboard/profile" target="_blank" rel="noreferrer noopener">' + esc(T.gateProfileBtn) + '</a>')
      return
    }

    var musts = '', quote = '', extra = []
    reasons.forEach(function (r) {
      var m = RE_MUSTS.exec(r)
      if (m) { musts = T.mustHaves(m[1], m[2]); return }
      var g = RE_MISSING.exec(r)
      if (g) { if (!quote) quote = oneLine(g[1]); return }
      if (r === 'Seniority gap for this role') extra.push(T.reasonSeniority)
      else if (r === 'Education requirement not met') extra.push(T.reasonEducation)
      else if (r === 'Experience in similar role') extra.push(T.reasonExperience)
    })

    var tier = (d.match_level && T.tiers[d.match_level]) ? d.match_level : tierOf(score)
    var html = head
    html += '<div class="blk t-' + tier + '">' +
      '<div class="score"><b>' + score + '</b><span>' + esc(T.tiers[tier]) + '</span>' +
      (musts ? '<em>' + esc(musts) + '</em>' : '') + '</div>' +
      '<div class="bar"><i style="width:' + clamp01(score) + '%"></i></div>' +
      (extra.length ? '<div class="note" style="margin-top:9px">' + esc(extra.join(' · ')) + '</div>' : '') +
      (d.score_fallback ? '<div class="src" style="margin-top:7px">' + esc(T.scoreFallback) + '</div>' : '') +
      '</div>'

    var qlow = quote.toLowerCase()
    var gaps = (Array.isArray(d.missing_skills) ? d.missing_skills : []).filter(function (s) {
      return s && String(s).toLowerCase() !== qlow
    }).slice(0, 10)
    if (quote || gaps.length) {
      html += '<div class="blk"><div class="lbl">' + esc(T.missing) + '</div>'
      if (quote) {
        html += '<div class="quote">« ' + esc(quote) + ' »</div>' +
          '<div class="src">' + esc(T.quotedFrom) + '</div>'
      }
      if (gaps.length) {
        html += '<div class="chips"' + (quote ? ' style="margin-top:10px"' : '') + '>' +
          gaps.map(function (s) { return '<span class="chip gap">' + esc(s) + '</span>' }).join('') + '</div>'
      }
      html += '</div>'
    }

    var have = Array.isArray(d.matched_skills) ? d.matched_skills.filter(Boolean).slice(0, 12) : []
    if (have.length) {
      html += '<div class="blk"><div class="lbl">' + esc(T.have) + '</div><div class="chips">' +
        have.map(function (s) { return '<span class="chip have">' + esc(s) + '</span>' }).join('') + '</div></div>'
    }

    setBody(html)
    setAct(offerActionsHTML())
    wireOfferActions()
  }

  function offerActionsHTML() {
    var T = t()
    var already = offer.saved || !!(offer.data && offer.data.already_saved)
    var save = already
      ? '<button class="btn btn-g" id="offerSave" disabled>' + IC.check + '<span>' + esc(T.offerAlready) + '</span></button>'
      : '<button class="btn btn-p" id="offerSave">' + IC.plus + '<span>' + esc(T.offerSave) + '</span></button>'
    return save +
      '<a class="btn btn-g" href="' + API_BASE + '/dashboard/cvs" target="_blank" rel="noreferrer noopener">' + esc(T.offerTailor) + '</a>' +
      '<div class="status" id="offerStatus" style="display:none"></div>'
  }
  function wireOfferActions() {
    var b = $('offerSave')
    if (b && !b.disabled) b.addEventListener('click', saveOffer)
  }

  function runOffer(force) {
    var T = t()
    if (offer.loaded && offer.url === location.href && !force) return
    offer.url = location.href
    offer.loaded = true
    offer.data = null
    offer.saved = false
    offer.pending = true
    offer.job = scrapeJob()
    if (view === 'page' && ctx === 'offer') renderOffer()
    send({ type: 'ANALYZE_JOB', job: offer.job }, function (resp) {
      offer.pending = false
      // `false` marks a transient failure (auth, network, timeout), which is not
      // the same as an authenticated user whose profile yields no score.
      var failed = !resp || resp.success === false
      offer.data = failed ? false : resp
      if (failed) { offer.loaded = false; offer.url = '' } // let the next open retry
      if (!failed && resp && typeof resp.match_score === 'number') setWidgetScore(Math.round(resp.match_score))
      if (view === 'page' && ctx === 'offer') renderOffer()
    })
  }

  function saveOffer() {
    var T = t()
    var btn = $('offerSave'), st = $('offerStatus')
    if (!btn || btn.disabled) return
    var job = (offer.job && offer.url === location.href) ? offer.job : scrapeJob()
    btn.disabled = true
    var span = btn.querySelector('span'); if (span) span.textContent = T.saving
    send({ type: 'SAVE_JOB', data: {
      title: job.title, company: job.company, description: job.description,
      url: job.url || location.href, source: 'page-capture', extraction_method: 'scrape',
    } }, function (saved) {
      var ok = !!(saved && saved.success)
      if (ok) {
        offer.saved = true
        loaded.jobs = false
        setAct(offerActionsHTML())
        wireOfferActions()
      } else {
        btn.disabled = false
        if (span) span.textContent = T.offerSave
        if (st) { st.style.display = 'block'; st.className = 'status err'; st.textContent = T.saveFailed }
      }
    })
  }

  // ---- context: apply --------------------------------------------------------
  function renderApply() {
    var T = t()
    var job = jobHeader()
    var head = jobHeadHTML(whereLine(T.whereApply), job.title || '', job.company || '')
    var html = head
    qRefs = []; fieldRefs = []; clRef = null; progRef = null; foldRef = null

    // CV in use
    if (cvCtx && cvCtx.name) {
      html += '<div class="cv blk">' + IC.doc.replace('<svg', '<svg class="doc"') +
        '<span class="n">' + esc(cvCtx.name) + '</span>' +
        '<button class="act-link" id="cvChange">' + esc(T.change) + '</button></div>'
    }

    // fields + their values
    if (applyPhase === 'filled') {
      html += '<div class="blk">' +
        '<button class="fold' + (detailOpen ? ' open' : '') + '" id="fold">' +
          '<span class="tk">' + IC.checkFat + '</span>' +
          '<b>' + esc(T.filled(filledCount)) + '</b>' +
          '<span class="more">' + esc(detailOpen ? T.hideDetail : T.seeDetail) + IC.chevronD + '</span>' +
        '</button>' +
        '<div class="sub">' + esc(T.reviewThem) + '</div>' +
        '<div id="fieldsWrap" style="' + (detailOpen ? 'margin-top:10px' : 'display:none') + '">' + fieldsHTML() + '</div>' +
      '</div>'
    } else if (readyFields.length) {
      html += '<div class="blk"><div class="lbl">' + esc(T.willWrite) + '</div>' + fieldsHTML() +
        (applyPhase === 'filling'
          ? '<div class="prog"><i id="progBar"></i></div>' +
            '<div class="prog-meta"><span id="progText">' + esc(T.filling(0, readyFields.length)) + '</span>' +
            '<button id="stopBtn">' + esc(T.stop) + '</button></div>'
          : '') +
        '</div>'
    }

    // attached CV
    if (attachState) {
      var atxt = attachState === 'attaching' ? T.attaching
        : attachState === 'error' ? T.attachFailed
        : T.attached(attachState.name || 'CV')
      html += '<div class="cv blk">' + IC.doc.replace('<svg', '<svg class="doc"') +
        '<span class="n">' + esc(atxt) + '</span>' +
        (attachState === 'attaching' ? '<span class="spin" style="margin-left:auto"></span>'
          : attachState === 'error' ? '' : '<span class="tk">' + IC.check.replace('<svg', '<svg style="width:13px;height:13px"') + '</span>') +
        '</div>'
    }

    // what stays with the user
    if (readySkipped.length) {
      html += '<div class="blk"><div class="lbl">' + esc(T.yours) + '</div><div class="you">'
      readySkipped.forEach(function (sk, i) {
        var required = sk.reason === 'required'
        html += '<div class="y"><span class="n">' + esc(sk.label || '') + '</span>' +
          '<span class="tag ' + (required ? 'req' : 'sens') + '">' + esc(required ? T.tagRequired : T.tagSensitive) + '</span>' +
          (required && sk.input ? '<button class="go" data-skip="' + i + '">' + esc(T.jump) + '</button>' : '') +
          '</div>'
      })
      html += '</div>' + (hasSensitive() ? '<div class="src" style="margin-top:7px">' + esc(T.sensitiveWhy) + '</div>' : '') + '</div>'
    }

    // the form's own questions (+ cover letter, which is one of them)
    var qs = readyQuestions.slice()
    if (readyCL) qs.push({ label: readyCL.label || T.clLabel, isCL: true })
    if (qs.length) {
      html += '<div class="blk"><div class="lbl">' + esc(T.questions) + '</div><div id="qList">'
      qs.forEach(function (q, i) {
        html += '<div class="q"><span class="txt">' + esc(q.label || '') +
          '<span class="st" style="display:none"></span></span>' +
          '<button class="btn-s" data-q="' + i + '"' + (q.isCL ? ' data-cl="1"' : '') + '>' + esc(T.draft) + '</button></div>'
      })
      html += '</div></div>'
    }

    if (!readyFields.length && !readySkipped.length && !qs.length) {
      html += '<div class="note blk">' + esc(T.noFields) + '</div>'
    }

    setBody(html)

    // actions
    if (applyPhase === 'idle' && readyFields.length) {
      setAct('<button class="btn btn-p" id="fillBtn">' + IC.check + '<span>' + esc(T.fillBtn(readyFields.length)) + '</span></button>' +
        (attachState ? '' : '<button class="btn btn-g" id="attachBtn">' + esc(T.attachCta) + '</button>') +
        '<div class="foot">' + esc(T.submitYours) + '</div>')
    } else if (applyPhase === 'filling') {
      setAct('<button class="btn btn-p" disabled><span class="spin"></span><span>' + esc(T.filling(0, readyFields.length)) + '</span></button>')
    } else if (applyPhase === 'filled') {
      setAct(attachState ? '' : '<button class="btn btn-g" id="attachBtn">' + esc(T.attachCta) + '</button>')
      if (bodyEl) {
        var f = document.createElement('div')
        f.className = 'foot left'
        f.textContent = T.submitYours
        bodyEl.appendChild(f)
      }
    } else {
      setAct('')
    }
    wireApply()
  }

  function hasSensitive() {
    for (var i = 0; i < readySkipped.length; i++) { if (readySkipped[i].reason !== 'required') return true }
    return false
  }

  function fieldsHTML() {
    var html = '<div class="fields" id="fieldList">'
    readyFields.forEach(function (f, i) {
      var done = applyPhase === 'filled' || (f.__done === true)
      html += '<div class="f' + (done ? '' : ' pending') + '" data-f="' + i + '">' +
        '<span class="k">' + esc(f.label || f.key || '') + '</span>' +
        '<span class="v">' + esc(f.value != null ? String(f.value) : '') + '</span>' +
        '<span class="s">' + (done ? '✓' : '') + '</span></div>'
    })
    return html + '</div>'
  }

  function wireApply() {
    var T = t()
    var fill = $('fillBtn')
    if (fill) fill.addEventListener('click', function () {
      if (!readyFields.length) return
      enterFilling()
      cmd('startFill')
    })
    var stop = $('stopBtn')
    if (stop) stop.addEventListener('click', function () { cmd('stopFill') })
    var att = $('attachBtn')
    if (att) att.addEventListener('click', function () {
      attachState = 'attaching'
      renderApply()
      cmd('attachCv')
    })
    var chg = $('cvChange')
    if (chg) chg.addEventListener('click', function () { switchView('me') })
    var fold = $('fold')
    if (fold) fold.addEventListener('click', function () {
      detailOpen = !detailOpen
      renderApply()
    })
    if (bodyEl) {
      var gos = bodyEl.querySelectorAll('button[data-skip]')
      for (var i = 0; i < gos.length; i++) {
        ;(function (btn) {
          btn.addEventListener('click', function () {
            var sk = readySkipped[Number(btn.getAttribute('data-skip'))]
            if (sk && sk.input) jumpToField(sk.input)
          })
        })(gos[i])
      }
      var qbtns = bodyEl.querySelectorAll('button[data-q]')
      qRefs = []
      for (var j = 0; j < qbtns.length; j++) {
        ;(function (btn) {
          var row = btn.closest ? btn.closest('.q') : null
          var st = row ? row.querySelector('.st') : null
          var idx = Number(btn.getAttribute('data-q'))
          var isCL = btn.getAttribute('data-cl') === '1'
          var label = row ? oneLine(row.querySelector('.txt') ? row.querySelector('.txt').childNodes[0].nodeValue : '') : ''
          qRefs[idx] = { btn: btn, st: st, label: label, isCL: isCL }
          if (isCL) clRef = qRefs[idx]
          btn.addEventListener('click', function () {
            if (btn.disabled) return
            startDraftUI(qRefs[idx])
            if (isCL) cmd('generateCoverLetter')
            else cmd('draftAnswer', idx)
          })
        })(qbtns[j])
      }
      fieldRefs = bodyEl.querySelectorAll('.f')
    }
    progRef = $('progBar')
    updateActShadow()
  }

  function startDraftUI(ref) {
    if (!ref) return
    var T = t()
    ref.btn.disabled = true
    ref.btn.innerHTML = '<span class="spin"></span>'
    if (ref.st) { ref.st.style.display = 'block'; ref.st.className = 'st'; ref.st.textContent = T.drafting }
  }
  function endDraftUI(ref, status) {
    if (!ref) return
    var T = t()
    ref.btn.disabled = false
    ref.btn.textContent = status === 'done' ? T.redraft : T.draft
    if (!ref.st) return
    ref.st.style.display = 'block'
    if (status === 'done') { ref.st.className = 'st ok'; ref.st.textContent = T.drafted }
    else if (status === 'limit') { ref.st.className = 'st err'; ref.st.textContent = T.aiLimit }
    else { ref.st.className = 'st err'; ref.st.textContent = T.draftFailed }
  }

  var pulsingFields = (typeof WeakSet !== 'undefined') ? new WeakSet() : null
  function jumpToField(input) {
    try {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (typeof input.focus === 'function') {
        try { input.focus({ preventScroll: true }) } catch (e) { input.focus() }
      }
      if (pulsingFields && pulsingFields.has(input)) return
      if (pulsingFields) pulsingFields.add(input)
      var po = input.style.outline, poff = input.style.outlineOffset
      input.style.outline = '2px solid #0064be'
      input.style.outlineOffset = '2px'
      setTimeout(function () {
        input.style.outline = po; input.style.outlineOffset = poff
        if (pulsingFields) pulsingFields.delete(input)
      }, 1600)
    } catch (e) { /* node gone */ }
  }

  function enterFilling() {
    applyPhase = 'filling'
    armFillWatchdog()
    renderApply()
  }
  function armFillWatchdog() {
    clearFillWatchdog()
    fillWatchdog = setTimeout(function () {
      fillWatchdog = null
      if (applyPhase !== 'filling') return
      // The fill never reported anything: fall back to the honest post-fill view
      // rather than spinning forever.
      applyPhase = 'filled'
      renderApply()
    }, 15000)
  }
  function clearFillWatchdog() { if (fillWatchdog) { clearTimeout(fillWatchdog); fillWatchdog = null } }

  // ---- render: jobs view -----------------------------------------------------
  function statusMeta(status) {
    var T = t(), s = String(status || '').toLowerCase()
    if (s.indexOf('interview') !== -1 || s.indexOf('entretien') !== -1 || s.indexOf('entrevist') !== -1) return { c: 'itw', l: T.statusInterview }
    if (s.indexOf('appl') !== -1 || s.indexOf('postul') !== -1) return { c: 'app', l: T.statusApplied }
    if (s.indexOf('draft') !== -1 || s.indexOf('brouillon') !== -1 || s.indexOf('borrador') !== -1) return { c: '', l: T.statusDraft }
    return { c: '', l: T.statusSaved }
  }
  function jobRowsHTML(list) {
    return '<div class="rows">' + list.map(function (r) {
      var title = r.title || r.job_title || r.role || 'Job'
      var company = r.company || r.company_name || ''
      var when = r.when || r.created_at || r.updated_at || ''
      var m = statusMeta(r.status)
      return '<button class="r" data-job="' + esc(r.id || '') + '">' +
        '<span class="m"><b>' + esc(title) + '</b>' +
        (company || when ? '<span>' + esc([company, when].filter(Boolean).join(' · ')) + '</span>' : '') + '</span>' +
        '<span class="st ' + m.c + '">' + esc(m.l) + '</span>' + IC.chevronR.replace('<svg', '<svg class="chev"') +
        '</button>'
    }).join('') + '</div>'
  }
  function wireJobRows() {
    if (!bodyEl) return
    var rows = bodyEl.querySelectorAll('button[data-job]')
    for (var i = 0; i < rows.length; i++) {
      ;(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-job')
          openTab(API_BASE + (id ? '/dashboard/jobs/' + encodeURIComponent(id) : '/dashboard/pipeline'))
        })
      })(rows[i])
    }
  }
  function openTab(url) { try { window.open(url, '_blank', 'noreferrer,noopener') } catch (e) { /* noop */ } }

  function renderJobs() {
    var T = t()
    bodyEl.className = 'body'
    setBody('<div class="loading"><span class="spin"></span></div>')
    setAct('<button class="btn btn-g" id="savePage">' + IC.plus + '<span>' + esc(T.saveAnyway) + '</span></button>' +
      '<div class="status" id="saveStatus" style="display:none"></div>')
    var sp = $('savePage'); if (sp) sp.addEventListener('click', saveThisPage)
    send({ type: 'GET_STATS' }, function (resp) {
      if (view !== 'jobs') return
      var list = (resp && Array.isArray(resp.recent_saves)) ? resp.recent_saves
        : (resp && Array.isArray(resp.recent)) ? resp.recent : []
      recentJobs = list
      var html = '<div class="blk"><div class="lbl">' + esc(T.jobsLabel) + '</div>'
      html += list.length ? jobRowsHTML(list.slice(0, 8)) : '<div class="note">' + esc(T.jobsEmpty) + '</div>'
      html += '</div>'
      html += '<button class="r" data-job="" style="border-top:1px solid var(--line-soft);padding-top:12px">' +
        '<span class="m"><b>' + esc(T.viewPipeline) + '</b></span>' + IC.chevronR.replace('<svg', '<svg class="chev"') + '</button>'
      setBody(html)
      wireJobRows()
      updateActShadow()
    })
  }

  // ---- save this page --------------------------------------------------------
  var SAVE_SIGNALS = [
    /apply|postuler|candidature/i,
    /salary|salaire|compensation/i,
    /requirements|qualifications|profil recherch/i,
    /full[- ]?time|part[- ]?time|cdi|cdd|temps plein/i,
    /responsibilit|missions|about the role|votre r[oô]le/i,
    /experience|exp[eé]rience/i,
  ]
  function saveScore(text) {
    var n = 0
    for (var i = 0; i < SAVE_SIGNALS.length; i++) { if (SAVE_SIGNALS[i].test(text)) n++ }
    return n
  }
  function saveStatus(msg, cls) {
    var st = $('saveStatus'); if (!st) return
    st.style.display = 'block'
    st.className = 'status ' + (cls || '')
    st.textContent = msg
  }
  function saveThisPage() {
    var T = t()
    var btn = $('savePage')
    if (!btn || btn.disabled) return
    var text = ''
    try {
      if (window.JobSwiperExtract && typeof window.JobSwiperExtract.collectPageText === 'function') {
        text = window.JobSwiperExtract.collectPageText(15000) // reads + strips PII in one call
      }
    } catch (e) { /* noop */ }
    if (!text || text.length < 200 || saveScore(text) < 2) { saveStatus(T.saveNotJob, 'err'); return }
    btn.disabled = true
    var span = btn.querySelector('span'); if (span) span.textContent = T.saving
    saveStatus(T.saving, '')
    send({ type: 'PARSE_JOB_PAGE', pageText: text, url: location.href }, function (parsed) {
      if (!parsed || !parsed.success || !parsed.job) return finishSave(false, null)
      var job = parsed.job
      var payload = {}
      for (var k in job) { if (Object.prototype.hasOwnProperty.call(job, k)) payload[k] = job[k] }
      payload.source = 'page-capture'
      payload.extraction_method = 'ai'
      payload.url = job.url || location.href
      send({ type: 'SAVE_JOB', data: payload }, function (saved) { finishSave(!!(saved && saved.success), job) })
    })
  }
  function finishSave(ok, job) {
    var T = t()
    var btn = $('savePage')
    if (btn) {
      btn.disabled = false
      var span = btn.querySelector('span'); if (span) span.textContent = T.saveAnyway
    }
    if (ok) {
      saveStatus(T.savedJob((job && job.title) || ''), 'ok')
      loaded.jobs = false
      if (view === 'jobs') renderJobs()
    } else saveStatus(T.saveFailed, 'err')
  }

  // ---- render: me view -------------------------------------------------------
  function renderMe() {
    var T = t()
    bodyEl.className = 'body'
    setBody('<div class="loading"><span class="spin"></span></div>')
    setAct('')
    send({ type: 'GET_PROFILE' }, function (pr) {
      if (view !== 'me') return
      if (pr && pr.locale) {
        var nl = pickLang(pr.locale)
        if (nl !== lang) { lang = nl; relocalizeChrome() }
      }
      var T2 = t()
      if (!pr || !pr.ok || !pr.profile) {
        bodyEl.className = 'body mid'
        setBody('<div class="empty blk"><h2>' + esc(T2.gateSignIn) + '</h2><p>' + esc(T2.gateSignInPlain) + '</p></div>')
        setAct('<a class="btn btn-p" href="' + API_BASE + '/login" target="_blank" rel="noreferrer noopener">' + esc(T2.gateSignInBtn) + '</a>')
        return
      }
      var p = pr.profile
      var html = '<div class="blk"><div class="lbl">' + esc(T2.profileLabel) + '</div>'
      var comp = pr.completeness
      if (comp != null) {
        var pct = clamp01(comp <= 1 ? comp * 100 : comp)
        var col = pct >= 80 ? 'var(--ok)' : pct >= 50 ? 'var(--blue)' : 'var(--warn)'
        html += '<div class="score" style="align-items:center"><b style="font-size:20px">' + Math.round(pct) + '%</b>' +
          '<span style="font-size:12.5px;font-weight:700;color:var(--muted)">' + esc(T2.completeness) + '</span></div>' +
          '<div class="meter"><i style="width:' + pct + '%;background:' + col + '"></i></div>'
      }
      var fullName = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name
      var rows = [
        ['full_name', fullName], ['email', p.email], ['phone', p.phone],
        ['city', p.city || p.location], ['current_company', p.current_company || p.company],
        ['linkedin_url', p.linkedin_url || p.linkedin],
      ]
      var kv = ''
      rows.forEach(function (r) {
        if (!r[1]) return
        kv += '<div class="kv"><span class="k">' + esc(T2.pf[r[0]] || r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>'
      })
      html += (kv ? '<div style="margin-top:10px">' + kv + '</div>' : '<div class="note" style="margin-top:8px">' + esc(T2.profileEmpty) + '</div>')
      html += '<button class="btn btn-g inline" id="editProfile" style="margin-top:12px">' + esc(T2.editProfile) + '</button></div>'
      html += '<div class="blk" id="cvBlock"><div class="lbl">' + esc(T2.cvsLabel) + '</div>' +
        '<div class="loading"><span class="spin"></span></div></div>'
      html += '<div class="blk"><div class="lbl">' + esc(T2.accountLabel) + '</div>' +
        '<button class="r" id="planLink"><span class="m"><b>' + esc(T2.managePlan) + '</b></span>' +
        IC.chevronR.replace('<svg', '<svg class="chev"') + '</button>' +
        '<button class="r" id="signOut"><span class="m"><b>' + esc(T2.signOut) + '</b>' +
        '<span>' + esc(T2.signOutNote) + '</span></span></button></div>'
      setBody(html)
      var ep = $('editProfile'); if (ep) ep.addEventListener('click', function () { openTab(API_BASE + '/dashboard/profile') })
      var pl = $('planLink'); if (pl) pl.addEventListener('click', function () { openTab(API_BASE + '/dashboard/settings/billing') })
      var so = $('signOut'); if (so) so.addEventListener('click', function () {
        send({ type: 'LOGOUT' }, function () { loaded.me = false; renderMe() })
      })
      loadCvs()
      updateActShadow()
    })
  }

  function loadCvs() {
    var block = $('cvBlock'); if (!block) return
    send({ type: 'GET_CVS' }, function (resp) {
      var T = t()
      var block2 = $('cvBlock'); if (!block2) return
      var head = '<div class="lbl">' + esc(T.cvsLabel) + '</div>'
      if (!resp || !resp.ok || !Array.isArray(resp.cvs) || !resp.cvs.length) {
        block2.innerHTML = head + '<div class="note">' + esc(T.cvsEmpty) + '</div>' +
          '<button class="btn btn-g inline" id="newCv" style="margin-top:10px">' + esc(T.newCv) + '</button>'
        var nc = $('newCv'); if (nc) nc.addEventListener('click', function () { openTab(API_BASE + '/dashboard/cvs') })
        return
      }
      var current = selectedCvId || resp.selectedCvId || resp.defaultCvId || resp.cvs[0].id
      var html = head + '<div class="rows">'
      resp.cvs.forEach(function (cv) {
        var on = cv.id === current
        html += '<button class="r" data-cv="' + esc(cv.id) + '">' +
          '<span class="m"><b>' + esc(cv.title || 'CV') + '</b></span>' +
          '<span class="st' + (on ? ' on' : '') + '">' + esc(on ? T.active : T.use) + '</span></button>'
      })
      html += '</div><button class="btn btn-g inline" id="newCv" style="margin-top:10px">' + esc(T.newCv) + '</button>'
      block2.innerHTML = html
      var nc2 = $('newCv'); if (nc2) nc2.addEventListener('click', function () { openTab(API_BASE + '/dashboard/cvs') })
      var btns = block2.querySelectorAll('button[data-cv]')
      for (var i = 0; i < btns.length; i++) {
        ;(function (btn) {
          btn.addEventListener('click', function () { pickCv(btn.getAttribute('data-cv')) })
        })(btns[i])
      }
    })
  }

  // The server only records a CV choice when it is tied to a saved job, so an ATS
  // page has nothing to record against. Persist the choice locally too, and let
  // the attach layer read it back, otherwise "Use" is a lie that resets on the
  // next page.
  var selectedCvId = null
  function pickCv(id) {
    if (!id) return
    selectedCvId = id
    storageSet({ jsw_selected_cv_id: id })
    cmd('selectCv', id)
    loadCvs()
  }

  // ---- context: none ---------------------------------------------------------
  function renderNone() {
    var T = t()
    var html = '<div class="blk"><div class="where">' + esc(hostLabel()) + '</div>' +
      '<div class="empty" style="margin-top:6px"><h2>' + esc(T.noneTitle) + '</h2><p>' + esc(T.noneBody) + '</p></div>' +
      '<button class="btn btn-g inline" id="savePage" style="margin-top:12px">' + IC.plus + '<span>' + esc(T.saveAnyway) + '</span></button>' +
      '<div class="status" id="saveStatus" style="display:none;margin-top:8px"></div></div>'
    html += '<div class="blk" id="recentBlock"></div>'
    setBody(html)
    setAct('')
    var sp = $('savePage'); if (sp) sp.addEventListener('click', saveThisPage)
    if (recentJobs) renderRecent()
    else send({ type: 'GET_STATS' }, function (resp) {
      if (view !== 'page' || ctx !== 'none') return
      recentJobs = (resp && Array.isArray(resp.recent_saves)) ? resp.recent_saves
        : (resp && Array.isArray(resp.recent)) ? resp.recent : []
      renderRecent()
    })
  }
  function renderRecent() {
    var T = t()
    var b = $('recentBlock'); if (!b || !recentJobs || !recentJobs.length) return
    b.innerHTML = '<div class="lbl">' + esc(T.resume) + '</div>' + jobRowsHTML(recentJobs.slice(0, 3))
    wireJobRows()
    updateActShadow()
  }

  // ---- views -----------------------------------------------------------------
  function switchView(name) {
    view = name
    var nav = $('nav')
    if (nav) {
      var btns = nav.querySelectorAll('button')
      for (var i = 0; i < btns.length; i++) btns[i].className = btns[i].getAttribute('data-view') === name ? 'on' : ''
    }
    if (scrollEl) scrollEl.scrollTop = 0
    if (name === 'page') renderPage()
    else if (name === 'jobs') renderJobs()
    else renderMe()
  }

  // Re-apply the chrome strings that live outside the rendered views after a late
  // locale flip; the views themselves are rebuilt on every render.
  function relocalizeChrome() {
    if (!root) return
    var T = t()
    var cb = $('collapseBtn'); if (cb) { cb.setAttribute('title', T.collapse); cb.setAttribute('aria-label', T.collapse) }
    var sb = $('sb'); if (sb) sb.setAttribute('aria-label', T.panelLabel)
    var nav = $('nav')
    if (nav) {
      var btns = nav.querySelectorAll('button')
      for (var i = 0; i < btns.length; i++) {
        var v = btns[i].getAttribute('data-view')
        if (v && T.nav[v]) btns[i].innerHTML = (NAV_ICON[v] || '') + esc(T.nav[v])
      }
    }
    var wc = $('wClose'); if (wc) { wc.setAttribute('title', T.widgetMenu); wc.setAttribute('aria-label', T.widgetMenu) }
    if (wMenuEl) {
      var labels = { hide: T.hideUntilVisit, domain: T.disableDomain, all: T.disableAll }
      var mb = wMenuEl.querySelectorAll('button')
      for (var j = 0; j < mb.length; j++) {
        var a = mb[j].getAttribute('data-act')
        if (labels[a]) mb[j].textContent = labels[a]
      }
    }
  }

  // ---- bus handlers ----------------------------------------------------------
  function onCtx(data) {
    var cv = (data && data.cv) || null
    if (cv && (cv.name || cv.tailored)) cvCtx = { name: cv.name, tailored: !!cv.tailored }
    if (view === 'page' && ctx === 'apply') renderApply()
  }

  function onDetecting() {
    if (applyPhase !== 'idle') return
    gateInfo = null
    if (ctx !== 'apply') setContext('apply')
  }

  function onReady(data) {
    var fields = (data && Array.isArray(data.fields)) ? data.fields : []
    // A post-fill re-detect on the SAME form reports 0 fillable inputs because
    // they are filled: keep the result summary. A genuinely new form resets it.
    if (applyPhase === 'filled' && !fields.length) return
    if (fields.length) applyPhase = 'idle'
    gateInfo = null
    readyFields = fields
    readySkipped = (data && Array.isArray(data.skipped)) ? data.skipped : []
    readyQuestions = (data && Array.isArray(data.questions)) ? data.questions : []
    readyCL = (data && data.coverLetter) || null
    detailOpen = false
    setContext('apply', true)
    if (!userSetCollapse) expand()
  }

  function onEmpty() {
    clearFillWatchdog()
    if (applyPhase === 'filled') return // the filled form is still on screen
    readyFields = []; readySkipped = []; readyQuestions = []; readyCL = null
    applyPhase = 'idle'
    evaluatePage(true)
  }

  function onProgress(data) {
    if (!data) return
    var T = t()
    if (applyPhase !== 'filling') enterFilling()
    armFillWatchdog()
    var total = data.total || readyFields.length || 0
    var index = data.index || 0
    if (progRef && total) progRef.style.width = (index / total * 100) + '%'
    var pt = $('progText'); if (pt) pt.textContent = T.filling(index, total)
    for (var i = 0; i < index && i < readyFields.length; i++) readyFields[i].__done = true
    tickFieldRows(index)
  }
  function tickFieldRows(upTo) {
    if (!bodyEl) return
    var rows = bodyEl.querySelectorAll('.f')
    for (var i = 0; i < rows.length && i < upTo; i++) {
      rows[i].className = 'f'
      var s = rows[i].querySelector('.s'); if (s) s.textContent = '✓'
    }
  }

  function onFilled(data) {
    clearFillWatchdog()
    filledCount = (data && data.count != null) ? data.count : readyFields.length
  }

  function onAttach(data) {
    var status = data && data.status
    if (status === 'attaching') attachState = 'attaching'
    else if (status === 'done') attachState = { name: (data && data.cvName) || 'CV' }
    else if (status === 'error') attachState = 'error'
    if (view === 'page' && ctx === 'apply') renderApply()
  }

  function onDone(data) {
    clearFillWatchdog()
    filledCount = (data && data.filled != null) ? data.filled : (filledCount || readyFields.length)
    // Fields that were attempted but did not stick are moved back into "this
    // stays yours" so nothing reads as both filled and still needed.
    if (data && Array.isArray(data.unfilled) && data.unfilled.length) {
      var labels = {}
      data.unfilled.forEach(function (u) { if (u && u.label) labels[u.label] = true })
      readyFields.forEach(function (f) { if (labels[f.label]) f.__done = false })
      readySkipped = readySkipped.concat(data.unfilled)
    }
    applyPhase = 'filled'
    setContext('apply', true)
  }

  function onError(data) {
    clearFillWatchdog()
    var kind = data && data.kind
    if (kind === 'signin' || kind === 'complete') {
      gateInfo = { kind: kind, message: data.message, href: data.href }
      applyPhase = 'idle'
      setContext('gate', true)
      return
    }
    // Anything else is a local failure, not an account problem: surface it where
    // the action was, without blowing away the page context.
    var T = t()
    var st = $('offerStatus') || $('saveStatus')
    if (st) { st.style.display = 'block'; st.className = 'status err'; st.textContent = (data && data.message) || T.saveFailed }
  }

  function onAnswer(data) {
    if (!data) return
    var ref = null
    if (data.label != null) {
      for (var i = 0; i < qRefs.length; i++) {
        if (qRefs[i] && !qRefs[i].isCL && qRefs[i].label && data.label.indexOf(qRefs[i].label.slice(0, 24)) !== -1) { ref = qRefs[i]; break }
      }
    }
    if (!ref && typeof data.index === 'number') ref = qRefs[data.index]
    if (!ref) return
    if (data.status === 'drafting') startDraftUI(ref)
    else endDraftUI(ref, data.status)
  }

  function onCoverLetter(data) {
    if (!clRef) return
    var status = data && data.status
    if (status === 'generating') startDraftUI(clRef)
    else endDraftUI(clRef, status === 'done' ? 'done' : status === 'limit' ? 'limit' : 'error')
  }

  // ---- page evaluation (context + SPA navigation) ----------------------------
  // Recomputed on mount, on expand, on every URL change and whenever the apply
  // layer says the page has no form. This is what keeps a job-board page from
  // sitting on a state nobody drives, and what stops a stale offer from being
  // shown (or saved) after an in-place navigation to another job.
  function evaluatePage(fromEmpty) {
    var next = resolveContext()
    if (next === 'offer') {
      var stale = offer.url && offer.url !== location.href
      if (stale) { offer.loaded = false; offer.data = null; offer.job = null; offer.saved = false; setWidgetScore(null) }
      setContext('offer', stale)
      if (!isCollapsed()) runOffer(false)
      else if (view === 'page') renderPage()
      return
    }
    if (next === 'apply' && !readyFields.length && !fromEmpty) {
      // A form is there but the apply layer has not reported yet.
      setContext('apply')
      return
    }
    setContext(next, true)
  }

  function isCollapsed() { return !!(sbEl && sbEl.classList.contains('collapsed')) }

  function startUrlWatch() {
    lastHref = location.href
    if (urlWatch) return
    urlWatch = setInterval(function () {
      if (location.href === lastHref) return
      lastHref = location.href
      // A new page: nothing from the previous one survives.
      readyFields = []; readySkipped = []; readyQuestions = []; readyCL = null
      applyPhase = 'idle'; attachState = null; gateInfo = null; filledCount = 0
      setWidgetScore(null)
      evaluatePage(false)
    }, 800)
  }
  function stopUrlWatch() { if (urlWatch) { clearInterval(urlWatch); urlWatch = null } }

  // ---- squeeze ---------------------------------------------------------------
  // A real side panel pushes the page instead of overlapping it. The margin is
  // EXACTLY the panel width, so no strip of host-page background shows next to
  // the panel.
  function ensureSqueezeStyle() {
    if (document.getElementById('jsw-squeeze-style')) return
    var s = document.createElement('style')
    s.id = 'jsw-squeeze-style'
    s.textContent = 'html.jsw-squeezed{margin-right:' + PANEL_W + 'px !important;' +
      'transition:margin-right .26s cubic-bezier(.4,0,.2,1) !important;}' +
      '@media (max-width:560px){html.jsw-squeezed{margin-right:0 !important;}}'
    ;(document.head || document.documentElement).appendChild(s)
  }
  function applySqueeze(on) {
    try {
      if (on) { ensureSqueezeStyle(); document.documentElement.classList.add('jsw-squeezed') }
      else document.documentElement.classList.remove('jsw-squeezed')
    } catch (e) { /* noop */ }
  }
  function removeSqueeze() {
    try {
      document.documentElement.classList.remove('jsw-squeezed')
      var s = document.getElementById('jsw-squeeze-style'); if (s) s.remove()
    } catch (e) { /* noop */ }
  }

  function collapse() {
    if (sbEl) sbEl.classList.add('collapsed')
    applySqueeze(false)
    userSetCollapse = true
    storageSet({ sidebarCollapsed: true })
  }
  function collapseSilent() { if (sbEl) sbEl.classList.add('collapsed'); applySqueeze(false) }
  function expand() {
    if (sbEl) sbEl.classList.remove('collapsed')
    applySqueeze(true)
    evaluatePage(false)
  }
  function userExpand() {
    expand()
    userSetCollapse = true
    storageSet({ sidebarCollapsed: false })
  }

  // ---- floating launcher -----------------------------------------------------
  function loadDisableState(cb) {
    storageGet(['jsw_disabled_all', 'jsw_disabled_domains', 'jsw_widget_pos', 'jsw_hidden_until', 'jsw_selected_cv_id'], function (o) {
      o = o || {}
      disabledAll = !!o.jsw_disabled_all
      disabledDomains = o.jsw_disabled_domains || {}
      widgetPos = o.jsw_widget_pos || null
      selectedCvId = o.jsw_selected_cv_id || null
      hiddenUntil = o.jsw_hidden_until || {}
      cb()
    })
  }
  var hiddenUntil = {}
  var HIDE_MS = 6 * 60 * 60 * 1000 // "until next visit": 6h of quiet on this host
  function isDisabledHere() {
    if (disabledAll || !!disabledDomains[HOST]) return true
    var until = hiddenUntil[HOST]
    return !!(until && Date.now() < until)
  }

  function setWidgetScore(score) {
    var el = $('wScore'); if (!el) return
    if (score == null) { el.className = 'w-score'; el.textContent = ''; return }
    var tier = tierOf(score)
    var col = tier === 'great' ? 'var(--ok)' : tier === 'good' ? 'var(--blue)' : tier === 'fair' ? 'var(--warn)' : 'var(--bad)'
    el.textContent = String(score)
    el.style.background = col
    el.className = 'w-score on'
  }

  function applyWidgetPos() {
    if (!widgetEl || !widgetPos) return
    var left = Math.max(4, Math.min(widgetPos.left, (window.innerWidth || 800) - 60))
    var top = Math.max(4, Math.min(widgetPos.top, (window.innerHeight || 600) - 60))
    widgetEl.style.left = left + 'px'
    widgetEl.style.top = top + 'px'
    widgetEl.style.right = 'auto'
    widgetEl.style.bottom = 'auto'
  }

  function setupWidget() {
    widgetEl = $('widget'); wMenuEl = $('wMenu')
    if (!widgetEl) return
    applyWidgetPos()

    widgetEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      if (e.target && e.target.closest && e.target.closest('.w-close')) return
      var r = widgetEl.getBoundingClientRect()
      dragState = { sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false }
      e.preventDefault()
    })

    if (!dragDocWired) {
      dragDocWired = true
      document.addEventListener('mousemove', function (e) {
        if (!dragState || !widgetEl) return
        if (!dragState.moved && Math.abs(e.clientX - dragState.sx) + Math.abs(e.clientY - dragState.sy) < 5) return
        dragState.moved = true
        widgetEl.classList.add('dragging')
        var vw = window.innerWidth, vh = window.innerHeight
        var w = widgetEl.offsetWidth, h = widgetEl.offsetHeight
        var left = Math.max(4, Math.min(e.clientX - dragState.ox, vw - w - 4))
        var top = Math.max(4, Math.min(e.clientY - dragState.oy, vh - h - 4))
        widgetEl.style.left = left + 'px'; widgetEl.style.top = top + 'px'
        widgetEl.style.right = 'auto'; widgetEl.style.bottom = 'auto'
      }, true)
      document.addEventListener('mouseup', function () {
        if (!dragState) return
        var wasDrag = dragState.moved
        dragState = null
        if (widgetEl) widgetEl.classList.remove('dragging')
        if (wasDrag && widgetEl) {
          var r = widgetEl.getBoundingClientRect()
          widgetPos = { left: Math.round(r.left), top: Math.round(r.top) }
          storageSet({ jsw_widget_pos: widgetPos })
        } else if (!wasDrag) {
          closeWidgetMenu(); userExpand()
        }
      }, true)
    }

    var wc = $('wClose')
    if (wc) wc.addEventListener('click', function (e) { e.stopPropagation(); toggleWidgetMenu() })
    if (wMenuEl) wMenuEl.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null
      if (b) onMenuAction(b.getAttribute('data-act'))
    })
  }

  function toggleWidgetMenu() {
    if (!wMenuEl || !widgetEl) return
    if (wMenuEl.classList.contains('open')) { closeWidgetMenu(); return }
    var r = widgetEl.getBoundingClientRect()
    wMenuEl.style.left = Math.max(8, r.left) + 'px'
    wMenuEl.style.top = (r.bottom + 6) + 'px'
    wMenuEl.classList.add('open')
    setTimeout(function () {
      if (!wMenuEl || !wMenuEl.classList.contains('open')) return
      var mr = wMenuEl.getBoundingClientRect()
      if (mr.bottom > window.innerHeight - 4) wMenuEl.style.top = Math.max(8, r.top - mr.height - 6) + 'px'
      if (mr.right > window.innerWidth - 4) wMenuEl.style.left = Math.max(8, window.innerWidth - mr.width - 8) + 'px'
      document.addEventListener('mousedown', outsideMenuClose, true)
    }, 0)
  }
  function outsideMenuClose(e) {
    var path = e.composedPath ? e.composedPath() : []
    if (path.indexOf(wMenuEl) !== -1 || path.indexOf(widgetEl) !== -1) return
    closeWidgetMenu()
  }
  function closeWidgetMenu() {
    if (wMenuEl) wMenuEl.classList.remove('open')
    document.removeEventListener('mousedown', outsideMenuClose, true)
  }

  // "hide" now persists for a few hours on this host, which is what the label
  // promises: a full-page-load board (Indeed, jobup) used to bring it straight
  // back on the very next offer. "domain"/"all" persist until turned back on.
  // The toolbar icon still force-opens past any of the three.
  function onMenuAction(act) {
    closeWidgetMenu()
    if (act === 'domain') { disabledDomains[HOST] = true; storageSet({ jsw_disabled_domains: disabledDomains }) }
    else if (act === 'all') { disabledAll = true; storageSet({ jsw_disabled_all: true }) }
    else if (act === 'hide') { hiddenUntil[HOST] = Date.now() + HIDE_MS; storageSet({ jsw_hidden_until: hiddenUntil }) }
    teardownVisual()
  }
  function teardownVisual() {
    closeWidgetMenu()
    stopUrlWatch()
    removeSqueeze()
    unbindBus()
    var host = document.getElementById(HOST_ID)
    if (host) host.remove()
    _mounted = false; root = null; sbEl = null; bodyEl = null; actEl = null; scrollEl = null
    widgetEl = null; wMenuEl = null
  }

  // ---- mount -----------------------------------------------------------------
  function mount() {
    if (document.getElementById(HOST_ID)) return
    loadFont()
    var host = document.createElement('div')
    host.id = HOST_ID
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;'
    ;(document.body || document.documentElement).appendChild(host)

    root = host.attachShadow({ mode: 'open' })
    root.innerHTML = shellHTML()

    sbEl = $('sb'); bodyEl = $('body'); actEl = $('act'); scrollEl = $('scroll')

    var nav = $('nav')
    if (nav) nav.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null
      if (b) switchView(b.getAttribute('data-view'))
    })
    var cb = $('collapseBtn'); if (cb) cb.addEventListener('click', collapse)
    if (scrollEl) scrollEl.addEventListener('scroll', updateActShadow)
    setupWidget()

    storageGet('sidebarCollapsed', function (o) {
      if (iconOpenRequested) { iconOpenRequested = false; userSetCollapse = true; expand(); return }
      if (o && typeof o.sidebarCollapsed === 'boolean') {
        userSetCollapse = true
        if (o.sidebarCollapsed) collapseSilent(); else expand()
      } else collapseSilent() // default: launcher only, non-intrusive
    })

    bindBus({
      ctx: onCtx, detecting: onDetecting, ready: onReady, empty: onEmpty,
      progress: onProgress, filled: onFilled, attach: onAttach, done: onDone,
      error: onError, answer: onAnswer, coverletter: onCoverLetter,
    })

    startUrlWatch()
    evaluatePage(false)
    replayBusState()
  }

  function replayBusState() {
    var b = bus()
    if (!b || typeof b.last !== 'function') return
    var ready = b.last('ready')
    if (ready) { try { onReady(ready) } catch (e) { /* noop */ } return }
    var err = b.last('error')
    if (err) { try { onError(err) } catch (e) { /* noop */ } }
  }

  function doMount() {
    if (_mounted) return
    _mounted = true
    clearLazyTriggers()
    var built = false
    function build() {
      if (built) return
      built = true
      mount()
    }
    var timer = setTimeout(build, 500)
    send({ type: 'GET_PROFILE' }, function (resp) {
      if (resp && resp.locale) lang = pickLang(resp.locale)
      clearTimeout(timer)
      build()
      relocalizeChrome()
      if (view === 'page') renderPage()
    })
  }

  // ---- gated lazy mount ------------------------------------------------------
  var lazyOffs = []
  function clearLazyTriggers() {
    for (var i = 0; i < lazyOffs.length; i++) { try { lazyOffs[i]() } catch (e) { /* noop */ } }
    lazyOffs = []
    window.removeEventListener('popstate', maybeMount)
  }
  function maybeMount() {
    if (_mounted) return
    if (isDisabledHere()) return
    if (!isApplyPage() && !isRelevant()) return
    doMount()
  }
  function armLazyMount() {
    var b = bus()
    if (b && typeof b.on === 'function') {
      lazyOffs.push(b.on('detecting', maybeMount))
      lazyOffs.push(b.on('ready', maybeMount))
      lazyOffs.push(b.on('error', maybeMount))
      lazyOffs.push(b.on('empty', maybeMount))
    }
    var origPush = history.pushState
    history.pushState = function () {
      var ret = origPush.apply(this, arguments)
      maybeMount()
      return ret
    }
    window.addEventListener('popstate', maybeMount)
  }

  // Toolbar icon: force-mount (bypassing the auto-gate, so it also opens on a
  // listing that is not an apply form) and expand, but only on a relevant site.
  function revealSidebar() {
    if (!isRelevant() && !isApplyPage()) return false
    if (!_mounted) { iconOpenRequested = true; doMount() } else { userExpand() }
    return true
  }

  try {
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.type === 'JSW_OPEN_SIDEBAR') {
          var ok = false
          try { ok = revealSidebar() } catch (e) { ok = false }
          sendResponse({ opened: ok })
        }
      })
    }
  } catch (e) { /* noop */ }

  function boot() {
    loadDisableState(function () {
      if (isDisabledHere()) return
      if (isRelevant() || isApplyPage()) { doMount(); return }
      armLazyMount()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
