# Spec v4 : capture LinkedIn fiable + Auto Apply sur les ATS

Date : 2026-07-10 (v4 finale ; critiques multi-agents : v1 = 77 findings, v2 = 57, v3 = 50, tous intégrés ou explicitement arbitrés ; les 3 rapports servent de checklist de revue pour les PRs ; passe Codex à rejouer après le 9 août, quota ChatGPT épuisé)
Statut : en attente de relecture utilisateur, puis plan d'implémentation (pas de 4e passe de critique : rendements décroissants actés, plus aucun finding architecture en v3)
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
| Pièce jointe | **Chemin léger par défaut** : le CV tailoré existant (ou le CV de base) est proposé immédiatement ; "générer un CV sur-mesure" est une amélioration OPTIONNELLE non bloquante (badge "s'ouvre dans un onglet"), jamais un détour imposé au milieu de la candidature. Cover letter : HORS SCOPE v1. |
| Capture LinkedIn | DOM d'abord, IA en filet. Les content scripts LinkedIn (isolé ET MAIN world) RESTENT sur `/jobs/*` + `/comm/jobs/*`. Tout le reste (feed, messages, notifs) passe par la capture popup. Reload hack conservé jusqu'à preuve (protocole section 10). |
| Détection de champs | Hybride : heuristiques locales + edge function LLM. Allowlist stricte + classification dédiée du texte libre (section 8). |
| Capture hors /jobs/ | Popup "Sauvegarder cette page" : `activeTab` + `executeScript({allFrames: true})` au clic uniquement, avec **porte de plausibilité locale** (heuristique de signaux d'offre avant transmission ; si la page ne ressemble pas à une offre, avertissement et confirmation explicite). Grisé sur messagerie/feed/notifs LinkedIn. Pas de `<all_urls>`. |
| ATS v1 | Greenhouse (boards + job-boards), Lever, SmartRecruiters, Ashby, Recruitee, sur domaine ATS ou en iframe. **Limites assumées v1, repli popup** : widgets JS injectés sans iframe (embed.js et similaires) ET career sites en domaine personnalisé (CNAME). Les sous-domaines RECRUTEUR des ATS (hire.lever.co, app.smartrecruiters.com, app.ashbyhq.com, app.recruitee.com) sont explicitement EXCLUS (exclude_matches + garde runtime). Workday phase 2 (compte existant seulement). |
| Marquage IA durable | Flag booléen par champ rempli par IA, persisté côté app dans l'historique du job. JAMAIS le texte généré. |
| Couleur brand UI | Bleu #0064be, pas navy, pas violet. |

Hors portée (tickets séparés) : soumission automatique ; cover letter dans Auto Apply ; "direct send" ; widgets JS sans iframe et domaines CNAME (explo `optional_host_permissions` "activer sur ce site") ; Workday avec création de compte ; injection dans le feed LinkedIn.

## 3. Capture LinkedIn

### Couverture

- Matches des content scripts INCHANGÉS (`/jobs/*` + `/comm/jobs/*`, isolé et MAIN world). La fiabilité vient des 3 étages, la couverture hors /jobs/ vient du popup. Détecteur dormant hors présence d'un job.
- Reload hack (YOA-238) conservé tant que le protocole (section 10, variante hack désactivé) n'a pas prouvé que le patch `document_start` gagne systématiquement.

### Extraction en 3 étages

1. **DOM connu** : selectors actuels.
2. **Validation de plausibilité** : titre non vide, company non vide, description > 200 caractères. S'applique aussi au résultat IA.
3. **Filet IA** : texte du conteneur job (pas `body` entier quand identifiable), tronqué à 15 000 caractères, après minimisation locale (strip regex : emails, téléphones, URLs de profil). Le nom du recruteur ne peut pas être strippé de façon fiable : ce résidu est couvert par la base d'intérêt légitime documentée + zero-retention + non-persistance (section 8). Endpoint : `/api/extension/parse-job-page`, **épinglé zero-retention au même titre qu'`ats-apply-map`** (section 8).

### Télémétrie, circuit-breaker, budget

- `import-job` accepte `extraction_method: 'dom' | 'ai'` (numérateur + dénominateur). Alerte si taux de bascule horaire > seuil OU volume absolu `parse-job-page` > seuil.
- **Réalité du code assumée** : le moteur d'alertes actuel (`platform-alerts.ts`) est un évaluateur pull, stateless, à 4 types figés, évalué à l'ouverture de la page admin health. Les alertes de cette spec sont une EXTENSION NETTE de cet engine : nouveaux `alert_type`, filtre par ensemble d'opérations, et un évaluateur PLANIFIÉ (cron) avec état de déclenchement (single-fire par fenêtre, la fenêtre suivante repart propre). Livrable backend à part entière (phase 1a.0), pas une réutilisation gratuite.
- Budget de coût : alerte si le coût estimé journalier (`ai_usage_logs.estimated_cost_usd`) des opérations extension (`extension-page-extraction` + `ats-apply-map`) dépasse un seuil configuré. Étendu à `ats-apply-map` en 1b (phasage, section 11).

### Capture universelle (popup)

- `activeTab` + `executeScript({allFrames: true})` au clic uniquement. Porte de plausibilité locale AVANT transmission : heuristique de signaux d'offre (mots-clés candidature/salaire/mission, densité de texte) ; en dessous du seuil, avertissement "cette page ne ressemble pas à une offre, envoyer quand même ?" pour éviter d'expédier un webmail ou un intranet à l'IA sur un mis-clic.
- Limite documentée : iframe cross-origin hors host_permissions illisible même avec activeTab ; message "ouvre l'offre dans son propre onglet".
- Grisé sur messagerie/feed/notifs LinkedIn. Mention first-run : information de transmission (le consentement IA est traité section 8).

## 4. Auto Apply : pipeline

### Frames : élection continue

- Manifest ATS : `all_frames: true`, 5 domaines v1 seulement (les 7 autres retirés de content_scripts ET host_permissions), **exclude_matches sur les sous-domaines recruteur** (`hire.lever.co`, `app.smartrecruiters.com`, `app.ashbyhq.com`, `app.recruitee.com`) + garde runtime sur le hostname exact (les wildcards matchent aussi les back-offices, dont les écrans candidats du recruteur ont structurellement les mêmes champs).
- **Élection CONTINUE, pilotée par le background** : chaque frame remonte (frameId, input file présent, nombre de champs reconnus) quand son scan aboutit ; le background ré-évalue À CHAQUE rapport (pas seulement à l'ajout/retrait de frame : les scans finissent à des instants différents, un frame tardif doit pouvoir prendre la main). Priorité : input file > nombre de champs > profondeur. Le gagnant affiche l'UI, les autres restent dormants ; un ex-gagnant détrôné éteint son UI. **L'UUID de session est généré par le background au moment de la première élection** et diffusé aux frames avec le résultat (jamais généré localement par un frame).
- **Mode d'embed** : frame sans scroll interne (hauteur viewport du frame proche de la hauteur du document = embed auto-redimensionné) : `position: fixed` proscrit, pastille et barre en `absolute` près du formulaire. Sinon : `fixed` bas-gauche, position mémorisée par hostname.

### Étapes

1. **Détection du formulaire** (local). Scan du frame (inputs, textareas, selects, comboboxes ARIA, radios, checkboxes, file inputs, labels, options, required). Formulaire cible : input file, sinon le plus de champs de candidature ; recherche/newsletter ignorés ; iframes captcha exclus. Pastille Sparkles, tooltip first-run (une fois, globale, `chrome.storage.local`). Rien ne se remplit sans clic. **Readiness gate** : si `/api/extension/profile` revient vide ou sous un seuil minimal (pas de nom ou aucune expérience), la pastille affiche "Complète ton profil pour activer Auto Apply" avec deep-link vers l'app, et AUCUN écran de consentement juridique n'est montré à ce stade.
2. **Liaison au job** (local). Jaro-Winkler 0.6 company + 0.4 titre, seuil 0.82 ; un candidat : lié (corrigeable) ; plusieurs ou aucun : mini-liste. Aucun job lié = flux de première classe : "Sauvegarder ce job" en un clic. **Source de la description : portée par le SW quand le formulaire vit dans un frame cross-origin** (le content script du frame ne voit ni l'URL ni le DOM du parent, et le referrer est souvent vidé) : le SW connaît l'URL du top-frame (webNavigation/tabs), applique les patterns d'URL ATS (retrait de /apply, lien offre) et fetch la page d'offre pour la parser. À défaut : l'utilisateur colle l'URL ; à défaut : job "sans description" clairement marqué, réponses en mode générique réduit, utilisateur prévenu.
3. **Pièce jointe D'ABORD, chemin léger par défaut.** Si un champ Resume existe : le CV tailoré du job lié s'il existe, sinon le dernier CV de l'utilisateur, est proposé immédiatement ; "Générer un CV sur-mesure pour ce job" est un bouton secondaire NON bloquant (nouvel onglet, la candidature peut continuer sans lui ; s'il aboutit, la barre proposera "CV sur-mesure prêt, remplacer la pièce jointe"). L'upload précède le remplissage (parsing ATS asynchrone) ; fenêtre d'observation continue post-upload : MutationObserver 15 s sur les champs remplis, tout écrasement re-propose la suggestion.
4. **Mapping trivial** (local, instantané). S'exécute SANS le consentement IA (base : exécution du contrat), comme la pièce jointe.
5. **Mapping IA** (`ats-apply-map`). **Le consentement opt-in (section 8) est demandé ICI, à l'entrée de cette étape, juste avant le premier appel** : les étapes 1 à 4 fonctionnent sans. Entrée : champs restants autorisés + profil minimisé par intersection (5 expériences max, résumés tronqués) + job lié **avec description plafonnée à 6 000 caractères** (l'appel peut partir jusqu'à 8 fois par candidature, le coût marginal doit être borné). Wizard : chaque appel n'envoie que les champs de l'étape courante, les réponses des étapes passées ne sont pas régénérées. Sortie : champ vers valeur, réponses rédigées (langue de l'annonce), valeur cible texte libre pour comboboxes, "skip". Options tronquées à 50. **La classification du texte libre (section 8) est une seconde requête LLM séquentielle À L'INTÉRIEUR du même appel edge : un seul log d'usage, invisible du cap de 8, latence incluse dans la fourchette révisée 5 à 25 s.** État agrégé : "X réponses IA en rédaction…", avertissement sur "J'ai postulé" si rédactions en vol.
6. **Revue inline** (section 5).
7. **Soumission humaine.** "J'ai postulé" passe le job en Applied (rappel captcha si non résolu). Rappel différé : candidature "ouverte" = job lié ET (suggestion acceptée OU CV uploadé) ; rappel non bloquant au retour sur l'app, 7 jours, désactivable (livrable app, section 6.8).

### Écriture des valeurs

- **Inputs/textareas** : setters natifs + events, relecture anti-revert, validations serveur : ARIA (aria-invalid, aria-describedby) + fallback structurel (nœud adjacent error/invalid/danger dans les ~200 ms post-blur).
- **Selects natifs** : sélection d'option.
- **Comboboxes ARIA** : ouverture `pointerdown` + `mousedown` ; filtrage par setter natif + event `input` ; attente listbox par MutationObserver borné + re-lecture (3 x 200 ms). **La re-lecture ne traite que le rendu différé : une option virtualisée jamais montée (filtre qui ne la remonte pas en tête) part directement au fallback**, sans surestimer le taux d'auto-remplissage ; raffinement possible (frappe caractère par caractère jusqu'à unicité) avant de conclure. Sélection par `mousedown`, proximité Jaro-Winkler seuil 0.85. Fallback complet : menu jamais ouvert OU filtre ignoré OU aucune option au seuil. `isTrusted=false` assumé, fallback manuel de première classe.
- **File inputs** : transport binaire : SW fetch, base64, message (borne 10 Mo), reconstruction `File` côté content script, `DataTransfer`, vérification `input.files`, fallback "télécharge et dépose".

### Empreinte de formulaire (cache)

SHA-256 des tuples triés (label normalisé, type, required), ids générés exclus. Clé : hostname + empreinte + vPrompt + vDenylist. TTL 7 jours, structure seule.

### Multi-pages, navigation, état

- Changements d'étape : `webNavigation.onHistoryStateUpdated` + MutationObserver débouncé.
- **L'état de flux vit dans le SW, pas en accès direct** : `chrome.storage.session` reste en TRUSTED_CONTEXTS (un content script ne peut pas le lire, et l'ouvrir via setAccessLevel exposerait la session à tout script de la page). Le SW est la source de vérité : il détient le tabId (via sender), la clé (tabId + hostname + UUID d'élection), le TTL 60 min, et sert l'état aux frames par messaging. Le round-trip est assumé et borné (état lu à l'initialisation et aux transitions, pas à chaque rendu ; le content script garde une copie mémoire locale).
- Cap : 8 appels `ats-apply-map` par candidature, compté extension ET serveur.

### Architecture MV3

- Tous les appels réseau via le SW. Refresh token : `navigator.locks` dans le SW ; `storage.session` ne sert qu'au partage du token.
- Appels edge courts : port keep-alive. Attentes longues (PDF sur-mesure) : `chrome.alarms` (réveil, poll unique, sommeil ; timeout 20 min ; arrêt si l'onglet ATS ferme).

## 5. UX de proposition (option B, durcie)

- **Ghost en overlay** : ré-ancrage par identité stable via MutationObserver, repositionnement ResizeObserver + scroll passif, nettoyage des orphelins, ghost transparent aux clics, chip seul interactif, z-index maximal.
- **Barre flottante** : "n suggestions" (posées) + "X en rédaction…" (décompte), "Tout accepter", "Ignorer", "J'ai postulé", mention IA. Après "Tout accepter" : micro-message "Champs factuels remplis. N réponses IA à relire" + scroll vers la première.
- **"Tout accepter" borné** aux champs factuels courts ; réponses ouvertes acceptées une par une, texte entièrement visible.
- **États par champ** : suggestion, rédaction en cours, rempli, ambigu/skip, erreur serveur, sensible.
- **i18n extension** : FR/EN, locale depuis le profil, repli `navigator.language`.

## 6. Changements côté app (`job-swipers`)

Pattern commun : dual-auth + CORS + OPTIONS + service-role sur le chemin Bearer. Primitive partagée `checkQuotaWithClient(db, userId, operation)` extraite de `checkQuota` (utilisée par parse-job-page ; le quota auto-apply a sa propre mécanique, point 6).

1. **`/api/extension/parse-job-page`** : wrappe `extractJobFromText` paramétré d'une `operation` (`extension-page-extraction`). Gate de quota et comptage dans l'endpoint.
2. **`/api/extension/profile`** : profil plafonné + locale + indicateur de complétude (pour le readiness gate). Cache 30 min, purge au logout.
3. **Edge function `ats-apply-map`** : session de candidature (point 6), modèles épinglés zero-retention (section 8), log `logEdgeFunctionUsage` sous `ats-apply-map`, prompt versionné, classification texte libre intégrée (2e requête séquentielle interne, un seul log). **Vérifie le consentement côté serveur** (point 9) : refus 403 si absent ou révoqué.
4. **Pipeline PDF** : **le chemin on-demand est l'UNIQUE voie fiable** : route API dédiée, réponse 202 si génération en cours, exécution asynchrone par `waitUntil` Vercel sur cette route (PAS via l'autosave : `useCanvasAutoSave` est un hook client débouncé qui appelle une server action, aucun runtime pour y accrocher un Puppeteer ; au mieux l'autosave peut poster un pré-chauffage best-effort borné vers la même route). Stockage : bucket privé `cv-pdfs`, colonnes `generated_cvs.pdf_path` + `pdf_generated_at`, stale si canvas modifié après. Endpoint statut : `/api/extension/cv-pdf?jobId=` renvoie `{status: ready|generating|stale|none, url signée}`.
5. **`/api/extension/job-status`** : liked_job possédé passe en applied + flags "rempli par IA" (booléens).
6. **Quota `auto-apply` = table `auto_apply_sessions`**, mécanique DÉDIÉE : fonction `checkAutoApplySessionsQuota` qui compte les lignes de la table ; cette opération ne passe NI par `ai_quota_config` NI par `FALLBACK_QUOTA_CAPS` (ces mécanismes comptent des lignes `ai_usage_logs` par opération, structurellement incapables de regrouper N appels en 1 candidature). **Débit au premier événement de VALEUR** : la session est créée à l'entrée de l'étape 5 mais `billed_at` n'est posé qu'à la première réponse `ats-apply-map` exploitable (au moins un champ mappé ou une rédaction produite) ; un échec sec du premier appel ne consomme rien. Compteur d'appels serveur (cap 8, retries compris). Free : 3 lifetime (lignes avec `billed_at`). `plans.ts` display-only, note de sync.
7. **Compteur popup** : endpoint Bearer service-role used/limit via `auto_apply_sessions`.
8. **Rappel de confirmation candidature** (net-new, oublié des phases précédentes) : état + expiration 7 jours (colonnes sur `liked_jobs` ou table dédiée), surface = NotificationBell existant + bandeau au retour sur le dashboard. Phase 1b.
9. **Consentement côté serveur** : colonne `profiles.auto_apply_consent_at` (et champ distinct pour la case Art. 9, section 8), posée par l'app ou l'extension, vérifiée par `ats-apply-map`, révocable depuis les réglages extension ET app.

## 7. Erreurs et garde-fous

- Filet IA de capture en échec : message explicite, jamais de sauvegarde tronquée.
- `ats-apply-map` en échec : dégradation + réessayer ; le retry réutilise la session (pas de re-débit, cap 8 serveur) ; un échec sec du premier appel ne débite pas (billed_at, section 6.6).
- Token expiré : `navigator.locks`, état conservé, reconnexion popup.
- Revert, écrasement post-upload (15 s), validations serveur, captcha : section 4.
- Circuit-breakers et budget : section 3 (parse-job-page dès 1a, ats-apply-map en 1b).

## 8. Vie privée, conformité, Store

### Consentement et bases légales (séquencé, granulaire)

- **Exécution du contrat** : capture, liaison job, mapping trivial local, pièce jointe. Ces étapes ne demandent AUCUN consentement IA.
- **Consentement opt-in explicite** : demandé à l'entrée de l'étape 5 uniquement (envoi du profil au LLM + rédaction), écran clair (quoi, à qui, transfert US), retirable dans les réglages, état vérifié côté serveur (colonne dédiée).
- **Art. 9 : case DISTINCTE et granulaire, non prérequis** : "mes textes libres de profil peuvent contenir des infos sensibles, j'accepte leur traitement". Sans cette case, Auto Apply fonctionne en mode dégradé documenté : seuls les faits structurés du profil (postes, dates, compétences, formations) partent au LLM, les résumés/textes libres rédigés par l'utilisateur sont exclus du payload. On dégrade, on ne bloque pas.
- **Chemin capture** : base = intérêt légitime Art. 6(1)(f) pour la donnée résiduelle du recruteur (nom non strippable de façon fiable), avec test de mise en balance documenté et analyse Art. 14(5)(b) dans la DPIA. Mitigations : strip emails/téléphones/URLs de profil, zero-retention, non-persistance côté JobSwiper.

### Données envoyées à l'IA

- Allowlist de types remplissables + denylist EEO FR/EN versionnée en renfort ; champ non classé = sensible.
- **Texte libre, garantie reformulée honnêtement** : les LIBELLÉS des questions (jamais les valeurs, jamais accompagnés du profil) passent d'abord par le filtre local (denylist), puis sont transmis pour classification (requête dédiée sans profil) ; seuls les libellés classés légitimes entrent dans la requête de rédaction avec le profil minimisé ; aucun libellé classé sensible n'est réutilisé ni logué. On ne prétend PAS qu'aucun libellé sensible ne sera jamais transmis pour classification : une denylist est incomplète par nature, la protection est l'isolation (classification sans profil) + zero-retention.
- Minimisation : intersection schéma x profil ; plafond description job 6 000 caractères ; strip PII à la capture. Jamais les valeurs saisies sur la page.

### Rétention et transferts

- Rien de persisté côté JobSwiper au-delà de la requête ; `ai_usage_logs` = métadonnées ; flags IA sans texte. Caches extension : profil 30 min, structure 7 j, flux 60 min, purge au logout.
- **Zero-retention APPLIQUÉE, pas déclarée** : `parse-job-page` ET `ats-apply-map` sont contraints à des endpoints à politique zero-retention (routing OpenRouter avec contrainte de provider/data policy, ou appel direct au SDK du fournisseur épinglé). Les fournisseurs AVAL réels sont nommés dans subprocessors, TIA par destinataire. **Un test automatique échoue si un modèle non conforme est configuré pour ces deux opérations** (section 10).

### Artefacts juridiques

Privacy policy, ROPA, DPIA (PII tiers de la capture + Art. 9 + mise en balance intérêt légitime), TIA par fournisseur aval, subprocessors. **La DPIA du chemin capture et la TIA sont un PRÉREQUIS du rollout prod de 1a** (premier jet validé), pas seulement du dépôt Store : l'étage IA de capture tourne en prod dès 1a. AI Act : Annexe III 4(a), position assistant-du-candidat sous validation humaine, versant destinataire Art. 50 traité dans l'analyse, rôles actés.

### Chrome Web Store

- **Audit des host_permissions (pas seulement des matches)** : le reviewer lit les host_permissions d'abord. LinkedIn scopé à `https://*.linkedin.com/jobs/*` + `/comm/jobs/*` (les match patterns supportent les chemins ; en MV3 un content script statique n'a pas besoin de host_permission pour s'injecter, elles ne servent qu'aux fetch cross-origin du SW et à l'injection programmatique, or tout notre réseau va vers jobswiper.ai). Host_permissions ATS redondantes retirées ; ne reste large que jobswiper.ai. La permission `tabs` est auditée : si activeTab + scripting suffisent, elle saute.
- Privacy Practices : "web content" ET "personally identifiable information", finalités, Limited Use, AVANT soumission.
- `STORE_LISTING.md` réécrit en deux temps VRAIS et cohérents partout : "l'extension lit le DOM des pages job consultées pour détecter les offres (automatique sur /jobs/, pas de crawl hors navigation utilisateur)" ; "rien n'est transmis aux serveurs JobSwiper sans action explicite". **Le plan takedown utilise la même caractérisation** (pas de version édulcorée "sur action" : l'accès DOM est automatique, seule la transmission est sur action) ; réponse à un takedown réel = décision juridique de retrait de la capture DOM LinkedIn, distincte de la mitigation CWS.

## 9. Algorithmes de référence

- Liaison job : Jaro-Winkler, 0.6 company + 0.4 titre, seuil 0.82.
- Proximité option combobox : Jaro-Winkler, seuil 0.85.
- Empreinte : SHA-256 tuples triés, clé hostname+empreinte+vPrompt+vDenylist, TTL 7 j.
- Élection de frame : continue, à chaque rapport ; input file > nombre de champs > profondeur ; UUID généré par le background à la première élection.
- Session : (user_id, hostname, job_id) ; création à l'entrée de l'étape 5 ; débit à `billed_at` (première réponse exploitable) ; cap 8 serveur.

## 10. Tests

Bootstrap du harnais = premier item de la phase 1a.

- **3 niveaux de fixtures** : statiques ; hydratation simulée (ré-ancrage + écrasement post-upload différé) ; harnais React contrôlé (revert, writer combobox : cas succès et cas fallback complet, attente par observer).
- **Fixtures obligatoires, les 5 ATS couverts** : Greenhouse legacy + refonte + iframe ; Lever 2 pages (persistance état via SW) ; SmartRecruiters wizard 2 étapes (état, overlays, cap) ; **Ashby (formulaire + combobox)** ; **Recruitee (formulaire + locale)** ; **fixture multi-frames** (arbitrage entre frames concurrents + ré-élection quand un frame tardif rapporte de meilleures capacités) ; **fixture embed auto-redimensionné** (assertion absolute vs fixed + screenshot G.1).
- **Tests dédiés** : cap 8 (extension + serveur) ; idempotence du débit (échec du 1er appel = rien débité ; retry non re-débité) ; circuit-breaker (single-fire par fenêtre, fenêtre suivante propre) ; TTL/tabId/UUID (aucune réhydratation périmée) ; transport binaire PDF ; corpus labels sensibles FR/EN ; harnais permanent `ats-apply-map` (options dans la liste, rien hors allowlist, classification texte libre) ; **consentement** (absent = zéro appel `ats-apply-map`, 403 serveur ; révoqué en cours de session = appels suivants bloqués ; case Art. 9 absente = textes libres du profil exclus du payload) ; **test de configuration ZDR** (échoue si un modèle non zero-retention est configuré pour `parse-job-page` ou `ats-apply-map`).
- **Capture LinkedIn, protocole réaliste** : **comptes de test dédiés (jamais le compte admin prod)** ; les challenges/verifications LinkedIn sont comptés SKIP et rejoués, jamais comme échecs extension ; 100 tentatives réparties (détail, recherche, collections, guest) ; critère : 0 échec sec sur 100 ; **variante hack désactivé** (flag) pour décider du retrait du reload hack ; exécuté comme gate de release (pas en CI) + après toute refonte LinkedIn détectée par la télémétrie. En continu : télémétrie `extraction_method` par version d'extension dans l'admin (la mesure permanente).
- **Tests live pré-release** (manuels, UA `JobswiperSmoke`) : linkedin.com, un board par variante Greenhouse, un Lever.
- **Screenshots FR** de chaque état UX (dont readiness gate, écran de consentement, mode dégradé Art. 9), critique par axe G.1.

## 11. Phasage

| Phase | Contenu |
|---|---|
| 1a.0 | Fondations backend : `parse-job-page` (+ `extractJobFromText` paramétré + `checkQuotaWithClient`), `/api/extension/profile` (+ complétude), migration `auto_apply_sessions` + consentement (colonnes), `extraction_method` sur import-job, **extension de l'engine d'alertes (nouveaux types, évaluateur planifié, single-fire)**. |
| 1a | Extension capture : harnais de test (premier item), 3 étages + plausibilité + minimisation, capture popup (activeTab + porte de plausibilité), protocole statistique + variante sans hack. **Prérequis rollout prod : DPIA capture + TIA validées (premier jet).** |
| 1b | Moteur Auto Apply : manifest élagué + exclusions sous-domaines admin + all_frames + élection continue + modes d'embed, scan + cible, liaison job + création à la volée (JD via SW en cross-origin), chemin CV léger + pipeline PDF (waitUntil) + upload d'abord + fenêtre 15 s + transport binaire, mapping local + `ats-apply-map` (+ classification intégrée, consentement 403, latence 5-25 s), writer combobox, UX inline (état agrégé), `job-status` + compteur + **rappel candidature (6.8)** + consentement séquencé + readiness gate, i18n. **+ extension du circuit-breaker et du budget de coût à `ats-apply-map`. + suite de tests dédiée complète (section 10) comme condition de gel.** |
| 1c | Conformité/Store : privacy policy, ROPA/DPIA complète/TIA par fournisseur aval, Privacy Practices CWS, STORE_LISTING, audit host_permissions + `tabs`, analyse AI Act. Premier jet parallèle à 1b, passe de révision finale après gel de 1a/1b, bloque le dépôt Store. |
| 2 | Adapter Workday (compte existant seulement). |
| Explo | "Direct send" ; `optional_host_permissions` (widgets JS + CNAME). |

Dépendances : 1a.0 précède 1a et 1b. DPIA capture + TIA avant rollout prod de 1a. Le taux de liaison job de 1b se mesure après 1a en prod. 1c bloque le dépôt Store.
