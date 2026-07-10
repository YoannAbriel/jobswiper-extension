# Spec v2 : capture LinkedIn fiable + Auto Apply sur les ATS

Date : 2026-07-10 (v2, après critique multi-agents : 10 agents Claude, 77 findings intégrés ; passe Codex à rejouer après le 9 août, quota ChatGPT épuisé)
Statut : en attente de relecture utilisateur, puis plan d'implémentation
Repos concernés : `jobswiper-extension` (principal) + `job-swipers` (endpoints, edge function, quotas)

## 1. Contexte et objectifs

L'extension rate des pages de job sur LinkedIn (résultats de recherche, offres partagées hors `/jobs/`, échecs aléatoires liés au SPA et au shadow DOM). L'autofill existant (`content/autofill.js`) est embryonnaire : 9 champs, remplissage silencieux, profil jamais peuplé, aucune UI de proposition.

Objectifs :

1. Capturer un job depuis n'importe quelle page LinkedIn, et par extension depuis n'importe quel site carrière, sans échec sec.
2. Un vrai "Auto Apply" sur les ATS : détection des champs, contenu proposé (profil + réponses IA + pièces jointes), remplissage après validation. Le Submit final reste humain.
3. Une UX de proposition inline (suggestions champ par champ, option B validée).

## 2. Décisions validées

| Sujet | Décision |
|---|---|
| Scope Auto Apply | Remplir + l'utilisateur soumet. Jamais de soumission automatique. |
| UX de proposition | Suggestions inline champ par champ (ghost en overlay + chip Accepter/Modifier) + barre flottante. "Tout accepter" exclut les réponses IA longues (validation individuelle obligatoire). |
| Pièces jointes | CV tailoré du job lié (PDF pré-généré côté app). Si absent : génération via l'app dans un NOUVEL onglet, état du formulaire persisté. |
| Capture LinkedIn | DOM d'abord, IA en filet. Pas d'interception API Voyager. Reload hack conservé en dernier recours tant que la fiabilité n'est pas prouvée. |
| Détection de champs | Hybride : heuristiques locales pour le trivial + edge function LLM. Allowlist stricte : seuls les champs positivement classés non-sensibles partent vers l'IA. |
| Capture hors /jobs/ | Capture universelle via le popup, EXCLUE sur messagerie/feed/notifications LinkedIn. Pas d'injection dans le feed. |
| ATS v1 | Greenhouse, Lever, SmartRecruiters, Ashby, Recruitee, y compris leurs déploiements en iframe. Workday en phase 2 (compte existant seulement). |
| Couleur brand UI | Bleu #0064be (logo), pas navy, pas violet. |

Hors portée (tickets séparés) :

- Soumission automatique complète.
- "Direct send" depuis l'app vers la page de candidature après génération du CV (feature explo).
- Workday avec création de compte (la création de compte est une classe de flux différente : auth, vérification email, session. Le scope Workday phase 2 = candidature sur compte déjà connecté).
- Injection de boutons dans le feed LinkedIn.

## 3. Capture LinkedIn

### Couverture

- Les content scripts LinkedIn (`linkedin-main.js` MAIN world + `linkedin.js`) passent de `linkedin.com/jobs/*` à `linkedin.com/*`, MOINS une liste d'exclusion explicite : `/feed/`, `/messaging/`, `/notifications/`, `/mynetwork/`, `/login`, `/checkpoint/`. Sur ces chemins, aucun script ne s'exécute (exclusion par `exclude_matches` dans le manifest, pas seulement par détecteur runtime).
- Un détecteur léger active la logique uniquement si la page contient un job (URL `/jobs/`, panneau de détail présent). Sinon le script reste dormant : aucun DOM touché, aucun timer.
- Le hack de reload forcé est CONSERVÉ en dernier recours (il couvre la course perdue du patch shadow-DOM sur cold load, cause d'origine de YOA-238). Il ne sera retiré que si le protocole de test (section 10) démontre que le patch `document_start` gagne systématiquement.

### Fiabilité : extraction en 3 étages

1. **DOM connu** : extraction par selectors actuelle.
2. **Validation de plausibilité** : titre non vide, company non vide, description > 200 caractères. S'applique aussi au résultat du filet IA. Un job implausible n'est jamais sauvegardé silencieusement.
3. **Filet IA** : si extraction échouée ou implausible, envoi du texte principal de la page (tronqué à 15 000 caractères, en ciblant le conteneur du panneau job quand il est identifiable plutôt que `body` entier) + URL au nouvel endpoint `/api/extension/parse-job-page` (section 7.1 : `parse-ai-import` existant parse un PROFIL, pas un job, il n'est pas réutilisable). UX : bouton en mode "extraction intelligente…".

**Circuit-breaker** : si le taux de bascule vers le filet IA dépasse un seuil (selectors cassés pour tout le monde après une refonte LinkedIn), l'endpoint le détecte côté serveur (fenêtre glissante par heure) et alerte via `platform_alerts`. Le filet reste actif pour l'utilisateur (c'est sa raison d'être) mais l'équipe est prévenue avant que le coût LLM ne dérive.

### Capture universelle (popup)

- Nouveau bouton "Sauvegarder cette page" dans le popup, visible sur tout site, avec `allFrames: true` sur `chrome.scripting.executeScript` (les jobs vivent souvent dans un iframe).
- DÉSACTIVÉ (bouton grisé + explication) sur les surfaces LinkedIn exclues (messagerie, feed, notifications) : le contenu y est de la donnée personnelle de tiers, pas une offre. La capture d'un job aperçu dans le feed passe par l'ouverture de l'offre elle-même.
- Le popup affiche une mention explicite la première fois : "le contenu de la page est transmis à l'IA JobSwiper pour en extraire l'offre".

## 4. Auto Apply : pipeline

### Iframes : prérequis structurel

Greenhouse, Ashby et Recruitee (et une partie de Lever) sont massivement déployés en iframe embarqué sur le site carrière de l'employeur. En conséquence :

- L'entrée content_scripts ATS du manifest passe en `all_frames: true`.
- Le scan, les overlays et l'écriture s'exécutent DANS le frame qui contient le formulaire ; la pastille et la barre flottante s'affichent dans ce même frame (positionnement relatif au frame). La coordination éventuelle avec le top frame passe par `chrome.runtime` messaging avec `frameId`.
- Limite documentée : si le top frame (careers.acme.com) n'est couvert par aucune host_permission, le contenu de l'iframe ATS reste accessible car le content script matche l'URL DU FRAME (les domaines ATS sont dans le manifest). C'est le comportement standard de `content_scripts.matches` + `all_frames`.

### Étapes

1. **Détection du formulaire** (local, instantané). Scan du DOM du frame : inputs, textareas, selects natifs, comboboxes ARIA (`role="combobox"`/`aria-expanded`), radios, checkboxes, file inputs, avec label résolu, type, options connues, required. S'il y a plusieurs formulaires, le formulaire cible est celui qui contient un input file OU le plus grand nombre de champs de candidature reconnus ; les `<form>` de recherche/newsletter sont ignorés. Les iframes de captcha (reCAPTCHA/hCaptcha) sont exclus du scan. Résultat : le schéma du formulaire. Une pastille flottante "JobSwiper · Postuler avec l'IA" apparaît (cue Sparkles). Rien ne se remplit sans clic. L'ancien bouton flottant disparaît. Un tooltip first-run (une fois, `chrome.storage`) explique la pastille au premier ATS détecté.
2. **Liaison au job sauvegardé** (local). Fonction de score définie : normalisation (minuscules, accents retirés, suffixes légaux retirés : SAS, SARL, GmbH, LLC, Inc, Ltd), similarité Jaro-Winkler, score = 0.6 x company + 0.4 x titre, seuil 0.82. Au-dessus du seuil avec un seul candidat : lié automatiquement avec bandeau "Candidature chez X · Titre" et possibilité de corriger. Plusieurs candidats au-dessus du seuil, ou aucun : mini-liste des jobs récents. **Cas "aucun job lié" = flux de première classe** (c'est le cas majoritaire : arrivée directe sur l'ATS) : l'extension propose "Sauvegarder ce job dans JobSwiper" en un clic (titre + entreprise + description lus sur la page, via le filet IA au besoin), ce qui crée le job et débloque CV tailoré + réponses contextualisées. Le mode "continuer sans job lié" (profil seul) reste possible.
3. **Pièce jointe D'ABORD.** Si un champ Resume existe et qu'un CV tailoré est disponible, l'upload se fait AVANT le remplissage des champs : Greenhouse et d'autres ATS parsent le CV côté serveur et pré-remplissent des champs de manière asynchrone (1 à 3 s), ce qui écraserait des valeurs déjà acceptées. Après l'upload, vérification différée (3 à 5 s) que les champs déjà remplis n'ont pas été écrasés ; si oui, les suggestions sont re-proposées.
4. **Mapping trivial** (local, instantané). Identité, email, téléphone, ville, LinkedIn, portfolio : heuristiques locales, suggestions immédiates.
5. **Mapping IA** (edge function `ats-apply-map`). Entrée : schéma des champs restants NON sensibles (allowlist, section 9) + sous-ensemble du profil requis par le schéma (minimisation : coordonnées seulement si un champ contact existe, expériences seulement si une question le demande) + job lié. Sortie : champ vers valeur, réponses rédigées aux questions ouvertes (langue de l'annonce), valeur cible en texte libre pour les comboboxes (l'extension résout l'option côté client), "skip" pour l'inconnu. Budget : listes d'options tronquées à 50 entrées, profil plafonné (5 dernières expériences, résumés tronqués), `max_tokens` par appel aligné sur les étages de `cv-generate`. Latence attendue : 5 à 20 s, l'UI l'assume (les suggestions triviales sont déjà là, les réponses IA arrivent en deuxième vague avec un état "rédaction en cours" par champ).
6. **Revue inline** (humain). Voir section 5.
7. **Cover letter** : même logique que le CV si un champ dédié existe.
8. **Soumission humaine.** Bouton "J'ai postulé" dans la barre : passe le job en "Applied". Si un captcha non résolu est détecté dans le formulaire, un rappel "n'oublie pas le captcha" est affiché. Au retour sur l'app JobSwiper, un rappel non bloquant propose de confirmer les candidatures ouvertes non confirmées.

### Écriture des valeurs

- Inputs/textareas : setters natifs + events `input`/`change`/`blur` (pattern `fillField` actuel), puis relecture pour détecter un revert framework ; si revert, champ repassé en "à remplir toi-même".
- Selects natifs : sélection de l'`<option>` par valeur/texte.
- **Comboboxes ARIA (react-select et similaires)** : writer dédié, les options n'existent pas dans le DOM avant interaction et poser `.value` est un no-op. Séquence : focus/click pour ouvrir, frappe simulée pour filtrer, attente du rendu du listbox, click sur l'option la plus proche de la valeur cible. Si aucune option ne matche : champ "à remplir toi-même".
- File inputs : `DataTransfer`, puis VÉRIFICATION (`input.files.length` + nom du fichier) ; en cas d'échec (dropzone custom, uploader S3, isTrusted) : fallback explicite "télécharge le PDF (1 clic) et dépose-le ici", jamais d'échec silencieux.
- Après écriture + blur, détection des validations serveur (aria-invalid, aria-describedby vers un message d'erreur, classes error/invalid) : le champ en erreur repasse en "à corriger".

### Empreinte de formulaire (clé de cache)

Hash SHA-256 de la liste triée des tuples (label normalisé, type, required) de tous les champs détectés, en excluant les attributs id/name qui ressemblent à des tokens générés (regex : suites alphanumériques > 8 caractères sans voyelles régulières, ou UUID). Clé complète : hostname + empreinte. Le cache (chrome.storage.local, TTL 7 jours) ne stocke QUE la classification structurelle champ vers type sémantique, jamais les valeurs, toujours recalculées depuis le profil courant. Invalidation automatique si la version du prompt `ats-apply-map` change (version dans la réponse edge).

### Multi-pages et navigation

- Détection des changements d'étape : `chrome.webNavigation.onHistoryStateUpdated` (permission déjà acquise) + MutationObserver débouncé sur le conteneur du formulaire (les wizards SPA type SmartRecruiters ne déclenchent pas toujours d'événement d'historique).
- Lever fait un VRAI rechargement entre la description et `/apply` : l'état du flux (job lié, suggestions acceptées, étape) est persisté dans `chrome.storage.session` keyé par tabId + hostname, TTL 30 minutes, réhydraté au `document_idle` suivant.
- Cap : 8 appels `ats-apply-map` maximum par candidature (wizard + retries), au-delà la barre passe en mode manuel.

### Architecture MV3 (contraintes dures)

- TOUS les appels réseau (parse-job-page, profile, ats-apply-map, PDF, statut) passent par le background service worker via `chrome.runtime.sendMessage`, JAMAIS en fetch direct depuis le content script (CORS et CSP des ATS les bloquent ; `autofill.js` actuel fait ce fetch direct, c'est un bug à corriger au passage).
- Le service worker meurt après ~30 s : l'état du flux vit dans le content script + `chrome.storage`, le verrou single-flight du refresh token migre de la mémoire SW vers `chrome.storage.session`, et un port keep-alive est maintenu pendant les appels edge longs.

### Handoff "Générer le CV"

Le CTA ouvre `cv/[jobId]` dans un NOUVEL onglet (jamais de navigation de l'onglet ATS). Avant l'ouverture, snapshot complet de l'état (suggestions, valeurs acceptées/éditées, étape) dans `chrome.storage.session`. Quand l'export PDF du CV est prêt, le background le détecte (polling de l'endpoint PDF avec backoff, déclenché tant que l'onglet ATS est ouvert) et la barre flottante de l'onglet ATS propose "CV prêt, joindre". L'utilisateur revient sur l'onglet ATS intact.

## 5. UX de proposition (option B, durcie)

- **Ghost en overlay** : overlay positionné sur le champ, suggestion grisée + chip "Accepter / Modifier" ancré au champ. Cycle de vie spécifié : ré-ancrage via MutationObserver (le nœud input peut être remplacé par React : ré-résolution par identité stable label+name, jamais par référence de nœud) + repositionnement sur scroll/resize (ResizeObserver + listener scroll passif), nettoyage des overlays orphelins à chaque tick. Pointer-events : la zone ghost est transparente aux clics (l'utilisateur peut toujours cliquer le champ et taper), seul le chip est interactif. Z-index maximal dans le frame, avec détection de collision avec les headers sticky.
- **Barre flottante** : "JobSwiper · n suggestions · Tout accepter · Ignorer" + compteur restants + "J'ai postulé" + mention "contenu généré par IA, vérifie avant d'envoyer" (disclosure durable, voir section 9). Position : bas-gauche par défaut (le bas-droite est le territoire des widgets Intercom/cookies), déplaçable.
- **"Tout accepter" borné** : ne couvre que les champs factuels courts (identité, contacts, liens, ville, selects). Les réponses ouvertes rédigées par l'IA sont EXCLUES du bulk : chacune doit être acceptée individuellement, valeur entièrement visible (textarea dans l'overlay), pour forcer la relecture avant qu'un texte IA parte chez un recruteur.
- **États par champ** : suggestion (ghost), rédaction en cours (pulse Sparkles), rempli (surlignage bref émeraude), ambigu/skip (orange, "à remplir toi-même"), erreur de validation serveur (rouge, "à corriger"), sensible (jamais rempli, badge "champ personnel, à toi").
- **i18n de l'extension** : UI bilingue FR/EN, fichiers de messages dans le repo extension calqués sur les namespaces de l'app, locale résolue depuis le profil JobSwiper (`/api/extension/profile` renvoie la locale) avec repli sur `navigator.language`. Zéro franglais : le chrome suit la locale utilisateur, les réponses IA suivent la langue de l'annonce.
- Couleurs : bleu brand #0064be pour les cues JobSwiper/IA, émeraude pour "rempli", orange pour "à toi". Pas de violet, pas de gradient décoratif.

## 6. Changements côté app (`job-swipers`)

Tous les endpoints extension ci-dessous suivent le pattern complet de `import-job` : dual-auth (cookie OU Bearer) + headers CORS explicites + handler OPTIONS + **client service-role pour toute lecture/écriture DB et tout comptage de quota sur le chemin Bearer** (les helpers `checkQuota`/`logAIUsageBackground` instancient un client cookie, aveugle sous Bearer : RLS renvoie des counts à zéro et bloque les inserts ; `import-job` a déjà son chemin service-role bespoke, c'est le modèle).

1. **`/api/extension/parse-job-page`** (nouveau) : wrappe `extractJobFromText` (prompt `job-text-extraction`) et retourne le format job attendu par `import-job`. Ne PAS réutiliser `parse-ai-import` (il parse un profil candidat, format incompatible). Opération de quota propre, rate-limit, télémétrie du taux de bascule DOM vers IA (circuit-breaker section 3).
2. **`/api/extension/profile`** (nouveau) : payload profil complet (identité, contacts, liens, ville, locale, expériences/formations résumées avec plafonds de taille). Cache extension 30 min, purgé au logout.
3. **Edge function `ats-apply-map`** (nouvelle) : quota via `_shared/enforce-quota.ts`, modèle via `_shared/tier-policy.ts` (`resolveUserPlan`/`selectModel`), log via `logEdgeFunctionUsage` (les modules Node `usage-logger`/`tier-model-policy` sont inimportables en Deno). Prompt éditable dans `/admin/prompts`, sanitizer d'entrée, version de prompt renvoyée dans la réponse (invalidation du cache extension).
4. **PDF du CV pour l'extension** : endpoint dédié service-role qui sert le PDF déjà généré du CV canvas du job lié (pré-génération/cache côté app), PAS un rendu Puppeteer par candidature (`/api/export-cv` : 60 s max, cold-start Chrome, inadapté au flux).
5. **`/api/extension/job-status`** (nouveau, net-new confirmé : rien ne mute `liked_jobs.status` en Bearer aujourd'hui) : passe un liked_job possédé par l'utilisateur en "applied".
6. **Quota `auto-apply`** (kebab-case, comme toutes les opérations) : unité = 1 CANDIDATURE (hostname + job lié), pas 1 appel LLM ; les re-scans multi-pages et les retries après échec ne re-débitent pas. Migration `ai_quota_config` (tier free, `lifetime_limit` = 3, aligné sur les 3 CVs) + entrée `FALLBACK_QUOTA_CAPS['auto-apply']` + extension de `PlanLimits` dans `plans.ts` pour l'affichage pricing/popup. Career Pass/LTD : illimité.
7. **Compteur pour le popup** : endpoint Bearer service-role renvoyant used/limit/lifetime pour `auto-apply` (l'actuel `/api/extension/stats` ne porte aucun compteur d'usage IA). UX de limite propre à l'extension (le composant `UpgradeModal` de l'app n'existe pas côté extension) : bandeau quota + lien vers `/dashboard/pricing`.

## 7. Erreurs et garde-fous

- Filet IA de capture en échec (timeout, quota, page vide) : "Impossible d'extraire, ouvre l'offre et réessaie". Jamais de sauvegarde tronquée.
- `ats-apply-map` en échec : dégradation, les suggestions locales restent, barre "Réponses IA indisponibles, champs de base seulement" + réessayer (gratuit, même unité de quota).
- Token expiré en plein flux : refresh single-flight (verrou en storage, section 4), état conservé, reconnexion via popup en dernier recours.
- Revert framework, écrasement asynchrone post-upload CV, validation serveur : couverts en section 4 (écriture des valeurs, pièce jointe d'abord).
- Captcha présent non résolu : "J'ai postulé" affiche un rappel, le job n'est pas marqué applied tant que l'utilisateur ne confirme pas explicitement.
- Circuit-breaker de coût sur le filet IA (section 3) + cap de 8 appels mapping par candidature (section 4).

## 8. Vie privée, conformité, Store

### Données envoyées à l'IA

- **Allowlist, pas denylist** : seuls les champs positivement classés non sensibles par les heuristiques locales (identité, contacts, liens, ville, expérience, formation, motivation, disponibilité, prétentions salariales sur demande explicite de l'utilisateur) sont envoyés à `ats-apply-map`. Tout champ NON CLASSÉ est traité comme sensible : ni envoyé, ni rempli, badge "à toi". Les blocs EEO (genre, origine, handicap, statut vétéran, orientation, religion) restent une denylist de renfort par mots-clés FR/EN versionnée dans un fichier dédié du repo, mais la protection primaire est l'allowlist.
- Le schéma envoyé contient labels, types et options ; jamais les valeurs déjà saisies sur la page.
- Minimisation : le payload profil est l'intersection du schéma détecté et du profil (section 4, étape 5).
- Le texte de page ne part vers `parse-job-page` que sur action explicite, et jamais depuis messagerie/feed/notifications (exclusion manifest + popup grisé).

### Rétention

- Ni le texte de page, ni les schémas de formulaire, ni les réponses générées ne sont persistés côté serveur au-delà de la requête. `ai_usage_logs` ne stocke que les métadonnées (operation, model, tokens, durée, coût), jamais le contenu. Caches extension : profil 30 min, mapping structurel 7 jours, état de flux 30 min, tous purgés au logout.

### Artefacts juridiques (livrables de la spec, pas des options)

- Mise à jour de `jobswiper.ai/privacy` : trois nouveaux traitements (texte de page vers IA, schéma de formulaire vers IA, détection locale de champs sensibles jamais transmis).
- Entrée ROPA pour l'activité auto-apply, mini-DPIA (profil + candidature vers LLM US), TIA du transfert OpenRouter pour cette finalité, mise à jour subprocessors.
- **AI Act** : analyse de classification explicite dans le dossier de conformité. Position défendue : l'outil est un assistant du CANDIDAT (il rédige et pré-remplit sous validation humaine obligatoire), pas un système d'évaluation ou de sélection de personnes pour le compte d'un employeur, donc hors Annexe III 21(a). La disclosure Art. 50 est rendue durable : les réponses générées par IA sont marquées comme telles dans l'historique du job côté app (pas seulement une mention transitoire dans la barre).

### Chrome Web Store (positionnement, livrable à part entière)

- L'élargissement de `content_scripts.matches` EST un changement re-reviewé ; chaque release passe en review. Le prétendre neutre était faux.
- Déclaration Privacy Practices du dashboard CWS à mettre à jour (catégorie "web content" transmise à un service IA, finalité, certification Limited Use) AVANT la soumission.
- `STORE_LISTING.md` réécrit : la phrase "we only access job posting data when you click Save" doit rester VRAIE, d'où les exclusions messagerie/feed/notifs et le déclenchement sur action explicite uniquement. Description de l'Auto Apply cadrée single-purpose : "aide à candidater : pré-remplit avec TES données sous TA validation, tu soumets toi-même".
- Le script MAIN-world reste limité aux chemins job (mêmes exclusions que le content script) : il ne tourne jamais sur login, messagerie, feed.
- Risque ToS LinkedIn documenté et accepté : extraction DOM sur pages consultées par l'utilisateur, sur son action ; pas de crawl, pas d'API interne, pas de volume automatisé. Plan de repli si takedown : capture par popup uniquement.

## 9. Algorithmes de référence

Récapitulés ici pour l'implémentation (détails en section 4) :

- **Liaison job** : normalisation + Jaro-Winkler, score 0.6 company + 0.4 titre, seuil 0.82, ambiguïté = choix manuel.
- **Empreinte de formulaire** : SHA-256 des tuples triés (label normalisé, type, required), ids générés exclus, clé hostname+empreinte, TTL 7 jours, invalidation sur version de prompt, structure seulement.
- **Détection sensible** : allowlist de types sémantiques remplissables + denylist EEO de renfort (fichier versionné FR/EN).

## 10. Tests

Le repo extension n'a AUCUNE infra de test aujourd'hui : la phase 1a commence par le bootstrap du harnais (Playwright + extension unpacked + structure de fixtures). Ensuite :

- **Fixtures dynamiques, pas seulement gelées** : les bugs visés (hydratation SPA, shadow DOM, revert React) ne se reproduisent pas sur du HTML statique. Trois niveaux : fixtures statiques (scan de formulaire, mapping local), fixtures à hydratation simulée (script qui mute le DOM après coup, teste le ré-ancrage des overlays), harnais React minimal avec controlled inputs (teste le revert et le writer combobox). Une fixture Greenhouse EN IFRAME est obligatoire.
- **Tests sur pages vivantes** : un passage Playwright contre linkedin.com réel (compte de test) pour la capture, et contre au moins un board Greenhouse et un Lever réels pour le scan. Exécutés manuellement avant chaque release extension (pas en CI, trop fragiles), avec le UA `JobswiperSmoke` pour l'hygiène Sentry.
- **Multi-étapes** : fixture SmartRecruiters à 2 pages minimum, vérifiant la persistance de l'état et l'absence d'overlay orphelin après transition ; cas Lever avec vrai rechargement.
- **Edge function** : harnais permanent style `test/e2e` app pour `ats-apply-map` : options retournées toujours dans la liste fournie, aucun champ hors allowlist dans la sortie, quota décompté une fois par candidature (retry gratuit vérifié), usage loggé.
- **Capture LinkedIn, protocole chiffré** : baseline mesurée AVANT le fix (taux d'échec sur 30 tentatives réparties sur les 3 surfaces défaillantes), puis critère post-fix : 0 échec sec sur 30 tentatives dans les mêmes conditions (échec sec = ni extraction DOM ni filet IA). Rejoué à chaque release qui touche les selectors.
- **Screenshots FR** de chaque état UX (pastille, ghost, rédaction en cours, barre, quota, erreurs), critiqués par axe selon la règle G.1.
- **Détection sensible** : suite unitaire dédiée sur un corpus de labels réels FR/EN (y compris les formulations pièges type "voluntary self-identification") : zéro champ sensible dans les sorties.

## 11. Phasage

| Phase | Contenu |
|---|---|
| 1a.0 | Fondations backend : `/api/extension/parse-job-page`, `/api/extension/profile`, migration quota `auto-apply` + fallback caps, harnais de test extension (bootstrap). |
| 1a | Capture LinkedIn : élargissement + exclusions manifest, 3 étages + plausibilité, capture universelle popup (avec exclusions), circuit-breaker, protocole de test baseline/post-fix. Reload hack conservé. |
| 1b | Moteur Auto Apply : all_frames + support iframe, scan + formulaire cible, liaison job + création à la volée, upload CV d'abord + vérification, mapping local + `ats-apply-map`, writer combobox, UX inline complète, endpoints PDF/statut/compteur, i18n extension. ATS : Greenhouse, Lever, SmartRecruiters, Ashby, Recruitee. |
| 1c | Livrables conformité/Store : privacy policy, ROPA/DPIA/TIA, Privacy Practices CWS, STORE_LISTING, analyse AI Act. Bloquant pour la RELEASE, parallélisable avec 1b. |
| 2 | Adapter Workday (compte existant seulement, wizard multi-pages). La création de compte reste hors scope. |
| Explo | Ticket "direct send" app vers page de candidature. |

Dépendances : 1a.0 précède 1a et 1b. 1b peut démarrer en parallèle de 1a, mais son critère d'acceptation sur le taux de liaison job se mesure après que 1a a tourné en prod (la qualité des jobs sauvegardés conditionne le match). 1c est obligatoire avant toute soumission au Store.
