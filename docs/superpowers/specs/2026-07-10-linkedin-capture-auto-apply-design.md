# Spec v3 : capture LinkedIn fiable + Auto Apply sur les ATS

Date : 2026-07-10 (v3 ; v1 critiquée par 10 agents = 77 findings, v2 critiquée par 10 agents = 57 findings, tous intégrés ; passe Codex à rejouer après le 9 août, quota ChatGPT épuisé)
Statut : en attente de critique v3, puis relecture utilisateur, puis plan d'implémentation
Repos concernés : `jobswiper-extension` (principal) + `job-swipers` (endpoints, edge function, quotas, storage)

## 1. Contexte et objectifs

L'extension rate des pages de job sur LinkedIn (résultats de recherche, offres partagées hors `/jobs/`, échecs aléatoires liés au SPA et au shadow DOM). L'autofill existant (`content/autofill.js`) est embryonnaire et bugué (fetch direct depuis le content script, profil jamais peuplé, remplissage silencieux).

Objectifs :

1. Capturer un job depuis n'importe quelle page LinkedIn, et par extension depuis n'importe quel site carrière, sans échec sec.
2. Un vrai "Auto Apply" sur les ATS : détection des champs, contenu proposé (profil + réponses IA + CV tailoré), remplissage après validation. Le Submit final reste humain.
3. Une UX de proposition inline (suggestions champ par champ, option B validée).

## 2. Décisions validées

| Sujet | Décision |
|---|---|
| Scope Auto Apply | Remplir + l'utilisateur soumet. Jamais de soumission automatique. |
| UX de proposition | Suggestions inline (ghost en overlay + chip Accepter/Modifier) + barre flottante. "Tout accepter" exclut les réponses IA longues. |
| Pièce jointe | CV tailoré du job lié, servi depuis un cache PDF côté app (pipeline section 6.4). Cover letter : HORS SCOPE v1. |
| Capture LinkedIn | DOM d'abord, IA en filet. Les content scripts LinkedIn (isolé ET MAIN world) RESTENT sur `/jobs/*` + `/comm/jobs/*` : toutes les surfaces job de LinkedIn vivent sous ces chemins, et tout le reste (feed, messages, notifs) passe par la capture popup. Aucun élargissement de matches = pas de nouvelle surface d'injection à justifier en review. Reload hack conservé jusqu'à preuve (protocole section 10). |
| Détection de champs | Hybride : heuristiques locales + edge function LLM. Allowlist stricte + classification dédiée pour le texte libre (section 8). |
| Capture hors /jobs/ | Popup "Sauvegarder cette page" : `activeTab` + `chrome.scripting.executeScript({allFrames: true})` déclenché UNIQUEMENT au clic. Pas de `<all_urls>`, pas de content script ajouté. Grisé sur messagerie/feed/notifs LinkedIn. |
| ATS v1 | Greenhouse (boards + job-boards), Lever, SmartRecruiters, Ashby, Recruitee, hébergés sur domaine ATS ou en iframe. **Widgets JS injectés sans iframe dans le DOM employeur (embed.js Greenhouse, widgets SmartRecruiters/Recruitee) : limite assumée v1**, repli = capture popup ; `optional_host_permissions` "activer sur ce site" = ticket explo. Workday phase 2 (compte existant seulement). |
| Marquage IA durable | Flag booléen par champ rempli par IA, persisté côté app dans l'historique du job. JAMAIS le texte généré (cohérent avec la rétention, section 8). |
| Couleur brand UI | Bleu #0064be, pas navy, pas violet. |

Hors portée (tickets séparés) : soumission automatique ; cover letter dans Auto Apply ; "direct send" app vers page de candidature ; widgets JS sans iframe (explo optional_host_permissions) ; Workday avec création de compte ; injection dans le feed LinkedIn.

## 3. Capture LinkedIn

### Couverture

- Les matches des content scripts NE CHANGENT PAS (`/jobs/*` + `/comm/jobs/*`, isolé et MAIN world). La fiabilité vient des 3 étages ci-dessous, la couverture hors /jobs/ vient du popup. Le détecteur runtime reste dormant hors présence d'un job.
- Le reload hack (YOA-238) est conservé tant que le protocole (section 10) n'a pas prouvé, hack désactivé par flag, que le patch `document_start` gagne systématiquement.

### Extraction en 3 étages

1. **DOM connu** : selectors actuels.
2. **Validation de plausibilité** : titre non vide, company non vide, description > 200 caractères. S'applique aussi au résultat IA. Jamais de sauvegarde tronquée silencieuse.
3. **Filet IA** : envoi du texte du conteneur job (pas `body` entier quand le panneau est identifiable), tronqué à 15 000 caractères, APRÈS minimisation locale : strip des emails et numéros de téléphone par regex (la page d'une offre contient la PII du recruteur). Endpoint : `/api/extension/parse-job-page` (section 6.1).

### Télémétrie et circuit-breaker

- `import-job` accepte un champ `extraction_method: 'dom' | 'ai'` : le serveur voit numérateur ET dénominateur. Taux de bascule calculé par heure glissante ; alerte via le registre `platform_alert_config` existant (même mécanique que les alertes actuelles, pas un système parallèle) si taux > seuil configuré OU volume absolu d'appels `parse-job-page` > seuil horaire (double garde : le taux protège contre une casse selectors, le volume absolu contre une dérive organique).
- Budget de coût : alerte admin si le coût estimé journalier (`ai_usage_logs.estimated_cost_usd`) des opérations extension dépasse un seuil configuré. Couvre `parse-job-page` ET `ats-apply-map` (le chemin le plus cher).

### Capture universelle (popup)

- Mécanisme : `activeTab` (déjà acquis) + `executeScript({allFrames: true})` au clic du popup uniquement. Limite documentée : un iframe cross-origin dont le domaine n'est pas dans host_permissions peut rester illisible même avec activeTab ; le popup affiche alors "ouvre l'offre dans son propre onglet et réessaie".
- Grisé (avec explication) sur messagerie/feed/notifs LinkedIn.
- Première utilisation : mention explicite "le contenu de la page est transmis à l'IA JobSwiper pour en extraire l'offre" (information ; le consentement IA global est traité en section 8).

## 4. Auto Apply : pipeline

### Frames : élection obligatoire

- Entrée content_scripts ATS du manifest : `all_frames: true`, restreinte aux 5 ATS v1 (`*.greenhouse.io`, `*.lever.co`, `*.smartrecruiters.com`, `*.ashbyhq.com`, `*.recruitee.com`). **Les 7 autres domaines ATS actuels sont RETIRÉS du manifest** (content_scripts ET host_permissions) et seront réintroduits par release dédiée avec leur adapter. Un manifest minimal est un argument de review.
- **Élection de frame obligatoire** (pas "éventuelle") : chaque frame ATS scanne et remonte au background (frameId, présence d'un input file, nombre de champs de candidature reconnus). Le background élit UN frame gagnant (priorité : input file, puis nombre de champs, puis frame le plus haut dans l'arbre) et notifie tous les frames : le gagnant affiche l'UI, les autres restent dormants. Ré-élection sur mutation majeure (frame ajouté/retiré).
- **Mode d'embed détecté** : si le frame n'a pas de scroll interne (hauteur du viewport du frame proche de la hauteur du document = embed auto-redimensionné), `position: fixed` est proscrit : la pastille et la barre s'ancrent en `absolute` à proximité immédiate du formulaire (elles suivent le flux du document et restent visibles pendant le scroll parent). Sinon (page ATS pleine ou iframe scrollable), `fixed` bas-gauche, position mémorisée par hostname.

### Étapes

1. **Détection du formulaire** (local). Scan du frame : inputs, textareas, selects natifs, comboboxes ARIA, radios, checkboxes, file inputs, labels résolus, options connues, required. Formulaire cible dans le frame : celui avec input file, sinon le plus de champs de candidature reconnus ; formulaires recherche/newsletter ignorés ; iframes captcha exclus. Pastille "JobSwiper · Postuler avec l'IA" (Sparkles). Tooltip first-run : une fois, globale, `chrome.storage.local`. Rien ne se remplit sans clic.
2. **Liaison au job** (local). Normalisation (minuscules, accents, suffixes légaux) + Jaro-Winkler, score 0.6 company + 0.4 titre, seuil 0.82. Un seul candidat au-dessus : lié (corrigeable). Plusieurs ou aucun : mini-liste. **Aucun job lié = flux de première classe** : "Sauvegarder ce job" en un clic. Source de la description quand la page apply ne l'a pas (Lever /apply, wizards) : remonter à l'URL d'offre (referrer, lien "view job", pattern d'URL ATS connu : retrait du suffixe /apply) et la parser via le filet IA ; à défaut, l'utilisateur colle l'URL de l'offre ; à défaut, job créé "sans description" clairement marqué, réponses IA en mode générique réduit (l'utilisateur est prévenu que la personnalisation sera limitée).
3. **Pièce jointe D'ABORD** (si champ Resume + CV disponible) : l'upload précède le remplissage (les ATS parsent le CV et écrasent des champs en asynchrone). **Fenêtre d'observation continue** post-upload : MutationObserver sur les champs déjà remplis pendant 15 secondes (pas un check ponctuel) ; tout écrasement re-propose la suggestion.
4. **Mapping trivial** (local, instantané).
5. **Mapping IA** (`ats-apply-map`). Entrée : champs restants autorisés (allowlist + classification texte libre, section 8) + profil minimisé par intersection avec le schéma (plafonds : 5 expériences, résumés tronqués) + job lié. Pour un wizard : chaque appel n'envoie QUE les champs de l'étape courante ; les réponses des étapes précédentes ne sont pas régénérées. Sortie : champ vers valeur, réponses rédigées (langue de l'annonce), valeur cible texte libre pour les comboboxes, "skip". Options tronquées à 50. Latence assumée 5 à 20 s en deux vagues, avec **état agrégé** : la barre affiche "X réponses IA en rédaction…" (décompte), et "J'ai postulé" affiche un avertissement si des rédactions sont en vol.
6. **Revue inline** (section 5).
7. **Soumission humaine.** "J'ai postulé" passe le job en Applied (avec rappel captcha si un widget non résolu est présent). **Rappel différé** : une "candidature ouverte" n'existe que si job lié ET (au moins une suggestion acceptée OU un CV uploadé) ; au retour sur l'app, rappel non bloquant de confirmation, durée de vie 7 jours, désactivable.

### Écriture des valeurs

- **Inputs/textareas** : setters natifs + events `input`/`change`/`blur`, relecture anti-revert, détection des validations serveur : ARIA (aria-invalid, aria-describedby) ET fallback structurel (nœud adjacent avec classe error/invalid/danger apparu dans les ~200 ms post-blur). Champ en erreur : "à corriger".
- **Selects natifs** : sélection d'`<option>`.
- **Comboboxes ARIA (react-select et similaires)** : séquence corrigée : ouverture par `pointerdown` + `mousedown` (PAS click/focus, react-select ouvre sur mousedown) ; filtrage par setter natif + event `input` sur l'input de filtre (PAS de keydown synthétiques, l'état contrôlé lit `input`) ; attente du listbox par MutationObserver borné + boucle de re-lecture (3 tentatives, 200 ms, listes virtualisées) ; sélection de l'option par `mousedown` ; proximité option/valeur cible = Jaro-Winkler, seuil 0.85, sous le seuil : "à remplir toi-même". Conditions de fallback COMPLÈTES : menu jamais ouvert OU filtre non pris en compte OU aucune option au-dessus du seuil. `isTrusted=false` est une limite assumée : le fallback manuel est un chemin de première classe, pas un cas d'erreur.
- **File inputs** : transport binaire spécifié : le SW fetch le PDF, l'encode en base64, l'envoie par message (borne 10 Mo), le content script reconstruit `new File([bytes], name, {type:'application/pdf'})` et construit le `DataTransfer`. Vérification `input.files.length` + nom ; échec (dropzone, uploader S3, isTrusted) : fallback "télécharge le PDF (1 clic) et dépose-le ici".

### Empreinte de formulaire (cache)

SHA-256 des tuples triés (label normalisé, type, required), ids générés exclus. Clé : hostname + empreinte + version du prompt edge + **version de la denylist locale** (sinon une correction de classification resterait masquée par le cache 7 jours). TTL 7 jours, structure seulement, valeurs toujours recalculées.

### Multi-pages, navigation, état

- Changements d'étape : `webNavigation.onHistoryStateUpdated` + MutationObserver débouncé.
- État du flux (job lié, suggestions acceptées, étape, compteur d'appels) : `chrome.storage.session`, clé tabId + hostname + **identifiant de session propre** (UUID généré à l'ouverture du flux : le tabId seul est réutilisable par Chrome), TTL 60 minutes (un détour génération CV dépasse 30 min).
- Cap : 8 appels `ats-apply-map` par candidature, compté ET côté extension (état de flux) ET côté serveur (section 6.6, la ligne de session porte le compteur ; l'extension seule serait contournable).

### Architecture MV3

- TOUS les appels réseau via le background SW (CORS/CSP des ATS bloquent les fetch de content script ; le fetch direct actuel d'`autofill.js` est un bug corrigé au passage).
- **Refresh token : `navigator.locks` dans le SW** (mutual exclusion réelle ; un flag `storage.session` est racy, get/set non transactionnels). `storage.session` ne sert qu'au partage du token.
- Appels edge courts (5-20 s) : port keep-alive. **Attentes longues (handoff CV) : `chrome.alarms`** (permission déjà présente) : le SW se réveille, poll une fois, se rendort. Jamais de keep-alive continu multi-minutes.

### Handoff "Générer le CV" (détour actif, pas un poll passif)

Générer un CV est une session d'édition de plusieurs minutes, pas un rendu automatique. Le CTA ouvre `cv/[jobId]` dans un NOUVEL onglet ; snapshot de l'état avant ouverture ; au retour, si le formulaire ATS a expiré (session ATS), l'utilisateur est prévenu et l'état est réappliqué sur le formulaire rechargé. La disponibilité du PDF est détectée par `chrome.alarms` (poll de l'endpoint statut section 6.4 toutes les 30 s, timeout 20 minutes, arrêt si l'onglet ATS ferme) ; la barre propose alors "CV prêt, joindre".

## 5. UX de proposition (option B, durcie)

- **Ghost en overlay** : ré-ancrage par identité stable (label+name) via MutationObserver, repositionnement ResizeObserver + scroll passif, nettoyage des orphelins, ghost transparent aux clics (le champ reste utilisable), seul le chip est interactif, z-index maximal avec détection de collision sticky.
- **Barre flottante** : "JobSwiper · n suggestions" (n = posées, distinct du décompte "X en rédaction…"), "Tout accepter", "Ignorer", "J'ai postulé", mention IA. Position : voir mode d'embed (section 4). Après "Tout accepter" : micro-message "Champs factuels remplis. N réponses IA à relire individuellement" + scroll vers la première réponse en attente (sinon l'utilisateur croit à un bug en voyant le compteur non nul).
- **"Tout accepter" borné** aux champs factuels courts ; réponses ouvertes acceptées une par une, texte entièrement visible.
- **États par champ** : suggestion, rédaction en cours, rempli, ambigu/skip, erreur serveur, sensible.
- **i18n extension** : FR/EN, messages calqués sur les namespaces app, locale depuis `/api/extension/profile`, repli `navigator.language`.

## 6. Changements côté app (`job-swipers`)

Pattern commun : dual-auth + CORS + OPTIONS + service-role sur le chemin Bearer. **Nouvelle primitive partagée `checkQuotaWithClient(db, userId, operation)`** : le corps de `checkQuota` extrait et paramétré par un client injecté (l'actuel instancie un client cookie en interne, structurellement inutilisable sous Bearer ; `import-job` a déjà dû faire du bespoke pour ça). Utilisée par parse-job-page et le compteur popup.

1. **`/api/extension/parse-job-page`** : wrappe `extractJobFromText` APRÈS l'avoir paramétré d'une `operation` optionnelle (`extension-page-extraction` ; aujourd'hui l'opération `job-text-extraction` est hardcodée dans ses 3 appels de log, ce qui mélangerait la télémétrie avec l'import in-app). Gate de quota et comptage dans l'endpoint, pas dans l'extracteur.
2. **`/api/extension/profile`** : profil complet plafonné + locale. Cache extension 30 min, purgé au logout.
3. **Edge function `ats-apply-map`** : quota via la session de candidature (point 6), modèle via `_shared/tier-policy.ts` MAIS restreint pour cette opération à une liste de modèles épinglés à conditions zero-retention (exigence conformité, section 8) ; log via `logEdgeFunctionUsage` sous l'opération de télémétrie `ats-apply-map` ; prompt versionné (invalidation cache) ; classification texte libre (section 8) intégrée.
4. **Pipeline PDF (net-new, conçu ici car rien n'existe : ni bucket, ni colonne, ni cache)** :
   - Déclencheur : à la sauvegarde du canvas CV (débouncé via le flux `useCanvasAutoSave` existant, génération en tâche de fond), et à la demande (l'endpoint statut déclenche une génération si absent, répond 202).
   - Stockage : bucket Supabase Storage privé `cv-pdfs`, colonnes `generated_cvs.pdf_path` + `pdf_generated_at`.
   - Invalidation : PDF marqué stale si le canvas est modifié après `pdf_generated_at` ; régénération au prochain déclencheur.
   - Endpoint : `/api/extension/cv-pdf?jobId=` renvoie `{status: ready|generating|stale|none, url}` (URL signée courte durée). C'est la cible du poll `chrome.alarms`.
5. **`/api/extension/job-status`** (net-new) : liked_job possédé passe en applied ; porte aussi les flags "champs remplis par IA" (marquage durable, booléens par champ, jamais le texte).
6. **Quota `auto-apply` = table `auto_apply_sessions`** (net-new ; `enforceQuota`/`checkQuota` ne comptent que des lignes ai_usage_logs par appel, incapables de regrouper N appels en 1 candidature) : clé (user_id, hostname, job_id), créée au premier appel `ats-apply-map` de la candidature (débit idempotent : la création débite, les appels suivants réutilisent la session), compteur d'appels serveur (cap 8), indépendante du TTL extension. Le quota Free (3 lifetime) se compte sur les lignes de cette table. Migration + entrée `FALLBACK_QUOTA_CAPS['auto-apply']`. **`plans.ts`/`PlanLimits` est display-only : `ai_quota_config` + `auto_apply_sessions` sont l'autorité** (note de sync explicite, comme pour les 3 CVs).
7. **Compteur popup** : endpoint Bearer service-role used/limit/lifetime pour auto-apply (via `auto_apply_sessions`). UX de limite propre à l'extension (bandeau + lien pricing).

## 7. Erreurs et garde-fous

- Filet IA de capture en échec : message explicite, jamais de sauvegarde tronquée.
- `ats-apply-map` en échec : dégradation (suggestions locales + réessayer). Le retry réutilise la session de candidature : gratuit ET borné par le cap serveur de 8 appels (non abusable).
- Token expiré : `navigator.locks`, état conservé, reconnexion popup en dernier recours.
- Revert framework, écrasement post-upload (fenêtre 15 s), validations serveur (ARIA + fallback structurel), captcha : section 4.
- Circuit-breakers et budget de coût : section 3 (couvrent parse-job-page ET ats-apply-map).

## 8. Vie privée, conformité, Store

### Consentement et base légale

- **Base légale documentée** : exécution du contrat pour la capture et le remplissage profil ; **consentement explicite opt-in** (écran dédié au premier usage d'Auto Apply : ce qui est envoyé, à qui, transfert US ; retirable dans les réglages extension) pour l'envoi du profil et la rédaction IA ; le consentement couvre aussi le risque Art. 9 résiduel (un CV peut contenir des données de catégorie spéciale mises spontanément par l'utilisateur), traité dans la DPIA.
- La mention first-run de la capture (section 3) est une information ; le consentement Auto Apply est un opt-in distinct et bloquant.

### Données envoyées à l'IA

- **Allowlist** de types sémantiques remplissables ; denylist EEO FR/EN versionnée en renfort ; tout champ non classé = sensible, ni envoyé ni rempli.
- **Texte libre (questions ouvertes)** : une heuristique locale ne peut pas classer une question arbitraire. Traitement en deux temps côté edge : (a) classification du LABEL SEUL (sans aucun profil) comme "question de candidature légitime" vs "autre" ; (b) seules les questions légitimes passent à la rédaction avec le profil minimisé. Un label classé "autre" revient en "à remplir toi-même".
- Minimisation : intersection schéma x profil (Auto Apply) ; strip emails/téléphones du texte de page (capture, PII du recruteur) ; les deux flux documentés dans la DPIA.
- Le schéma envoyé ne contient jamais les valeurs déjà saisies sur la page.

### Rétention et transferts

- Aucun texte de page, schéma ou réponse générée persisté côté serveur JobSwiper au-delà de la requête ; `ai_usage_logs` = métadonnées seulement ; marquage IA durable = flags booléens sans texte (résout la contradiction v2). Caches extension : profil 30 min, structure 7 jours, flux 60 min, purge au logout.
- **Le claim de rétention ne vaut que pour JobSwiper** : pour l'aval, `ats-apply-map` est épinglée sur des modèles à conditions zero-retention/no-log ; les fournisseurs AVAL réels (pas seulement OpenRouter, simple routeur) sont nommés dans subprocessors, avec une TIA par destinataire.

### Artefacts juridiques (livrables 1c)

Privacy policy (3 nouveaux traitements), ROPA, DPIA (inclut PII tiers du chemin capture + risque Art. 9), TIA par fournisseur aval, subprocessors. **AI Act** : analyse écrite ; référence correcte = Annexe III point 4(a) (recrutement/sélection) ; position défendue : JobSwiper est un assistant du candidat sous validation humaine obligatoire, pas un système de sélection pour l'employeur ; le versant DESTINATAIRE de l'Art. 50 (le recruteur qui reçoit du texte IA) est traité explicitement dans l'analyse (position : après relecture et validation humaine champ par champ, le candidat est l'auteur de sa candidature ; l'analyse 1c conclut ou amende). Rôles fournisseur/déployeur actés.

### Chrome Web Store

- Chaque release passe en review ; le manifest v3 est MINIMAL : matches LinkedIn inchangés, ATS réduits aux 5 supportés, pas de `<all_urls>`. C'est l'argument central du dossier.
- Privacy Practices mis à jour AVANT soumission : "web content" (texte de page vers IA, sur action) ET "personally identifiable information" (profil vers LLM pour rédaction), finalités, certification Limited Use.
- `STORE_LISTING.md` réécrit en deux temps distincts et vrais : "l'extension lit le contenu de la page pour détecter les offres" (accès) ; "le contenu n'est transmis à JobSwiper que sur ton action explicite" (transmission). L'ancienne phrase "we only access job posting data when you click Save" était déjà fausse (les content scripts lisent le DOM au chargement pour détecter) : on ne la répare pas, on la remplace.
- ToS LinkedIn : risque documenté (extraction sur pages consultées, sur action, pas de crawl). **Deux plans distincts** : mitigation CWS = déclenchement sur action + manifest minimal (ci-dessus) ; réponse à un takedown LinkedIn réel = décision juridique de retrait de la capture DOM LinkedIn (repli : import manuel + autres boards), pas une variante technique.

## 9. Algorithmes de référence

- Liaison job : Jaro-Winkler, 0.6 company + 0.4 titre, seuil 0.82.
- Proximité option combobox : Jaro-Winkler, seuil 0.85.
- Empreinte : SHA-256 tuples triés, clé hostname+empreinte+vPrompt+vDenylist, TTL 7 j, structure seule.
- Élection de frame : input file > nombre de champs > profondeur, élue par le background.
- Session de candidature : (user_id, hostname, job_id), débit à la création, cap 8 appels serveur.

## 10. Tests

Bootstrap du harnais (Playwright + extension unpacked + fixtures) = PREMIER item de la phase 1a (le repo n'a aucune infra de test).

- **3 niveaux de fixtures** : statiques (scan, mapping local) ; hydratation simulée (mutations différées : ré-ancrage overlays, et une fixture qui écrase 2-3 champs remplis 2 s après un upload CV pour tester la fenêtre d'observation) ; harnais React contrôlé (revert, writer combobox : cas "option trouvée" et cas "fallback complet" : menu non ouvert, filtre ignoré, aucune option au seuil, avec attente par observer, pas de sleep).
- **Fixtures obligatoires** : Greenhouse legacy `boards.greenhouse.io` ET refonte `job-boards.greenhouse.io` (deux DOM distincts), Greenhouse en iframe, Lever 2 pages (vrai rechargement, persistance `storage.session`), SmartRecruiters wizard 2 étapes minimum (état conservé, pas d'overlay orphelin, cap d'appels).
- **Tests dédiés** : cap 8 appels (extension + serveur), idempotence du débit de session (retry ne re-débite pas), circuit-breaker (simulation de dépassement en fenêtre glissante, une seule alerte, fenêtre suivante propre), expiration TTL + réutilisation de tabId (aucune réhydratation d'état périmé grâce à l'UUID de session), transport binaire PDF (reconstruction File + fallback), corpus de labels sensibles FR/EN (zéro sortie sensible), harnais permanent `ats-apply-map` (options dans la liste, rien hors allowlist, classification texte libre).
- **Capture LinkedIn, protocole statistique** : script Playwright automatisé, 100 tentatives réparties sur les surfaces (détail, recherche, collections, guest) ; critère : 0 échec sec sur 100 (borne supérieure de l'IC 95 % environ 3 %). **Variante hack désactivé** (flag) : même protocole, mesure le patch `document_start` seul ; le reload hack n'est retiré que si cette variante passe. En continu : télémétrie `extraction_method` par version d'extension dans l'admin (la vraie mesure permanente, le test ponctuel n'est qu'un gate de release).
- **Tests live pré-release** (manuels, UA `JobswiperSmoke`) : linkedin.com réel, un board de chaque variante Greenhouse, un Lever réel.
- **Screenshots FR** de chaque état UX, critique par axe G.1.

## 11. Phasage

| Phase | Contenu |
|---|---|
| 1a.0 | Fondations backend uniquement : `parse-job-page` (+ paramétrage `extractJobFromText` + `checkQuotaWithClient`), `/api/extension/profile`, migration `auto_apply_sessions` + `ai_quota_config` + fallback caps, `extraction_method` sur import-job + alertes. |
| 1a | Extension capture : bootstrap du harnais de test (premier item), 3 étages + plausibilité + minimisation, capture popup (activeTab, exclusions), protocole statistique baseline/post-fix + variante sans hack. Matches inchangés, reload hack conservé. |
| 1b | Moteur Auto Apply : manifest ATS élagué + all_frames + élection de frame + modes d'embed, scan + formulaire cible, liaison job + création à la volée (avec source JD), pipeline PDF (app) + upload d'abord + fenêtre d'observation + transport binaire, mapping local + `ats-apply-map` + classification texte libre, writer combobox corrigé, UX inline complète (état agrégé 2e vague), `job-status` + compteur popup + consentement opt-in, i18n extension. |
| 1c | Conformité/Store : privacy policy, ROPA/DPIA/TIA par fournisseur aval, Privacy Practices CWS, STORE_LISTING réécrit, analyse AI Act. Premier jet parallèle à 1b, **passe de révision finale obligatoire après gel de 1a/1b, avant tout dépôt Store**. |
| 2 | Adapter Workday (compte existant seulement). |
| Explo | "Direct send" ; `optional_host_permissions` pour les widgets JS sans iframe. |

Dépendances : 1a.0 précède 1a et 1b. Le critère de taux de liaison job de 1b se mesure après que 1a a tourné en prod. 1c gèle sur 1a/1b et bloque la release.
