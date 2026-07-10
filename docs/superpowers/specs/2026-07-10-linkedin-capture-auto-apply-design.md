# Spec : capture LinkedIn fiable + Auto Apply sur les ATS

Date : 2026-07-10
Statut : validé en brainstorming, en attente de plan d'implémentation
Repos concernés : `jobswiper-extension` (principal) + `job-swipers` (endpoints, edge function, quotas)

## 1. Contexte et objectifs

L'extension rate des pages de job sur LinkedIn (résultats de recherche, offres partagées hors `/jobs/`, échecs aléatoires liés au SPA et au shadow DOM). L'autofill existant (`content/autofill.js`) est embryonnaire : 9 champs, remplissage silencieux, profil jamais peuplé (TODO endpoint dédié), aucune UI de proposition.

Objectifs :

1. Capturer un job depuis n'importe quelle page LinkedIn, et par extension depuis n'importe quel site, sans échec sec.
2. Un vrai "Auto Apply" sur les ATS : détection des champs, contenu proposé (profil + réponses IA + pièces jointes), remplissage après validation. Le Submit final reste humain.
3. Une UX de proposition inline validée par l'utilisateur (option B du brainstorm).

## 2. Décisions validées

| Sujet | Décision |
|---|---|
| Scope Auto Apply | Remplir + l'utilisateur soumet. Jamais de soumission automatique. |
| UX de proposition | Suggestions inline champ par champ (ghost en overlay + chip Accepter/Modifier) + barre flottante "Tout accepter". |
| Pièces jointes | CV tailoré du job lié (export PDF du CV canvas). Si absent : CTA "Générer le CV" vers l'app. |
| Capture LinkedIn | DOM d'abord, IA en filet (`parse-ai-import`). Pas d'interception API Voyager. |
| Détection de champs | Hybride : heuristiques locales pour le trivial + edge function LLM pour le reste. |
| Capture hors /jobs/ | Capture universelle via le popup ("Sauvegarder cette page"), pas d'injection dans le feed. |
| ATS v1 | Greenhouse, Lever, SmartRecruiters, Ashby, Recruitee. Workday en phase 2. |
| Couleur brand UI | Bleu #0064be (logo), pas navy, pas violet. |

Hors portée (tickets séparés) :

- Soumission automatique complète.
- "Direct send" depuis l'app vers la page de candidature après génération du CV (feature explo, ticket à créer).
- Workday (phase 2 : wizard multi-pages + création de compte, adapter dédié une fois le moteur stable).
- Injection de boutons dans le feed LinkedIn.

## 3. Capture LinkedIn

### Couverture

- Les content scripts LinkedIn (`linkedin-main.js` MAIN world + `linkedin.js`) passent de `linkedin.com/jobs/*` à `linkedin.com/*`.
- Un détecteur léger active la logique uniquement si la page contient un job (URL `/jobs/`, panneau de détail présent). Sinon le script reste dormant (aucun DOM touché, aucun timer lourd).
- Le hack de reload forcé (compteur `__jobswiper_reload_done`) est supprimé : chargé partout dès `document_start`, le patch shadow-DOM précède toujours le bundle LinkedIn.

### Fiabilité : extraction en 3 étages

1. **DOM connu** : extraction par selectors actuelle (rapide, inchangée sur le fond).
2. **Validation de plausibilité** : titre non vide, company non vide, description > 200 caractères. Un job implausible n'est plus sauvegardé silencieusement.
3. **Filet IA** : si extraction échouée ou implausible, envoi de `document.body.innerText` tronqué (~15k caractères) + URL à `/api/parse-ai-import`, qui retourne un job structuré passé ensuite au flux `SAVE_JOB` normal. UX : le bouton passe en "extraction intelligente…" (spinner 2-3 s de plus). Plus jamais de "Could not extract".

### Capture universelle (popup)

- Nouveau bouton "Sauvegarder cette page" dans le popup, visible sur tout site.
- Récupère le texte de la page active via `chrome.scripting.executeScript` (permissions `activeTab` + `scripting` déjà acquises) et passe par le même filet IA.
- C'est le chemin de capture pour le feed, les messages, les notifs LinkedIn, et tout site carrière inconnu.

## 4. Auto Apply : pipeline

Étapes (schéma validé dans le brainstorm) :

1. **Détection du formulaire** (local, instantané). Sur un domaine ATS supporté, scan du DOM : inputs, textareas, selects, radios, checkboxes, file inputs, avec label résolu (aria-label, label[for], placeholder, name, conteneur), type, options, required. Résultat : le schéma du formulaire. Une pastille flottante "JobSwiper · Postuler avec l'IA" apparaît (cue Sparkles). Rien ne se remplit sans clic. L'ancien bouton flottant qui remplissait silencieusement disparaît.
2. **Liaison au job sauvegardé** (local). Match entreprise + titre lus sur la page contre les jobs sauvegardés. Trouvé : bandeau "Candidature chez X · Titre ✓". Sinon : mini-liste des jobs récents pour choisir, ou "continuer sans job lié" (mode dégradé : profil seul, pas de CV tailoré ni de réponses contextualisées).
3. **Mapping trivial** (local, instantané). Identité, email, téléphone, ville, LinkedIn, portfolio : heuristiques locales (FIELD_MAP étendu), suggestions affichées immédiatement.
4. **Mapping IA** (edge function `ats-apply-map`, ~3-6 s, en parallèle de 3). Entrée : schéma des champs restants + profil + job lié. Sortie : champ → valeur, réponses rédigées aux questions ouvertes (dans la langue de l'annonce), option choisie pour chaque dropdown/radio (parmi les options réelles uniquement), "skip" pour l'inconnu. Le mapping structurel est caché par (hostname + empreinte de formulaire) dans `chrome.storage.local` avec TTL ; les valeurs sont recalculées par utilisateur/job.
5. **Revue inline** (humain). Voir UX ci-dessous.
6. **Pièces jointes**. Champ Resume : propose le PDF du CV canvas tailoré du job lié. Absent : CTA "Générer le CV pour ce job" qui ouvre `cv/[jobId]` dans l'app ; le formulaire conserve son état au retour. Idem lettre de motivation si champ présent. Injection du fichier via `DataTransfer` sur l'input file.
7. **Soumission humaine**. Bouton "J'ai postulé" dans la barre : passe le job en "Applied" dans le pipeline JobSwiper. Pas de détection automatique du submit.

### Multi-pages

Le moteur re-scanne à chaque changement d'étape (wizards SmartRecruiters, futur Workday). Pastille et état survivent à la navigation interne (SPA et rechargements dans le même flux de candidature).

## 5. UX de proposition (option B validée)

- **Ghost en overlay** : on n'injecte pas de texte dans les inputs du site tiers. Un overlay positionné sur le champ affiche la suggestion grisée + un chip "Accepter / Modifier" ancré au champ. À l'acceptation, écriture via les setters natifs + events `input`/`change`/`blur` (pattern `fillField` actuel).
- **Barre flottante** : "JobSwiper · n suggestions · Tout accepter · Ignorer", + compteur des champs restants, + "J'ai postulé", + mention "contenu généré par IA, vérifie avant d'envoyer" (disclosure Art. 50, cohérente avec les éditeurs).
- **États par champ** : suggestion (ghost), rempli (surlignage bref), ambigu ou "skip" IA (marqueur orange "à remplir toi-même"), sensible (jamais rempli, voir ci-dessous).
- **Modifier** : ouvre l'édition de la valeur dans l'overlay (textarea pour les réponses longues) avant écriture.
- Couleurs : bleu brand #0064be pour les cues JobSwiper/IA, vert émeraude pour "rempli", orange pour "à toi de jouer". Pas de violet, pas de gradient décoratif, pas d'em dash dans la copy.

## 6. Changements côté app (`job-swipers`)

1. **`/api/parse-ai-import`** : passe en dual-auth (cookie ou Bearer extension), même pattern que `import-job`.
2. **`/api/extension/profile`** (nouveau) : payload profil complet pour l'autofill et le contexte IA (identité, contacts, liens, ville, expériences/formations résumées). Cache extension 30 min, invalidé au logout.
3. **Edge function `ats-apply-map`** (nouvelle) : l'opération IA du mapping + rédaction. `verify_jwt: false` avec auth manuelle interne (pattern maison), usage loggé via `usage-logger` (obligatoire), modèle résolu par `tier-model-policy`, prompt éditable dans `/admin/prompts`, sanitizer d'entrée.
4. **Export CV pour l'extension** : `/api/export-cv` accepte le Bearer extension (ou endpoint dédié retournant le PDF du CV canvas du job).
5. **Quotas** : nouvelle opération `auto_apply` dans `ai_quotas` (Free : petit quota lifetime, cohérent avec les 3 CVs ; Career Pass/LTD : illimité). Compteur visible dans le popup. Déclenche `UpgradeModal`/limit-reached comme les autres opérations.
6. **Statut "Applied"** : la mise à jour de statut du job est exposée en Bearer si ce n'est pas déjà le cas.

## 7. Erreurs et garde-fous

- **Filet IA de capture échoue** (timeout, quota, page vide) : message "Impossible d'extraire, ouvre l'offre et réessaie". La validation de plausibilité s'applique aussi au résultat IA. Jamais de sauvegarde tronquée silencieuse.
- **`ats-apply-map` échoue** : dégradation, pas de blocage. Les suggestions locales restent ; la barre affiche "Réponses IA indisponibles, champs de base seulement" + bouton réessayer.
- **Token expiré en plein flux** : refresh single-flight existant ; si échec, état des suggestions conservé, la barre propose la reconnexion via le popup.
- **Écriture qui ne prend pas** (framework qui revert) : relecture de la valeur après `fillField` ; si écrasée, le champ repasse en "à remplir toi-même".

## 8. Vie privée et conformité

- Le schéma envoyé à l'IA contient labels, types et options ; jamais les valeurs déjà saisies par l'utilisateur sur la page.
- **Champs sensibles (EEO)** : genre, origine ethnique, handicap, statut vétéran. Détection par mots-clés multilingues côté extension. Ni envoyés à l'IA, ni auto-remplis. Listés "à remplir toi-même".
- Le texte de page ne part vers `parse-ai-import` que sur action explicite (clic Save ou clic pastille).
- Disclosure IA visible sur la barre flottante (Sparkles + mention de vérification).
- Store : aucune permission nouvelle ; `linkedin.com/*` est déjà dans les host_permissions. Pas de re-review à risque.

## 9. Tests

- **Fixtures HTML gelées** dans le repo extension : LinkedIn (détail, recherche, guest), formulaires Greenhouse/Lever/SmartRecruiters/Ashby/Recruitee. Runner Playwright avec extension unpacked : bouton présent, extraction correcte, schéma de formulaire complet, suggestions posées, valeurs écrites survivant au re-render.
- **Filet IA** testé en mock (réponse `parse-ai-import` simulée) + un smoke test réel jetable contre l'edge function.
- **Screenshots FR** de chaque état UX (pastille, ghost, barre, erreurs), critiqués par axe selon la règle G.1 du CLAUDE.md app.
- **Critère d'acceptation LinkedIn** : sur les 3 surfaces défaillantes identifiées (recherche, hors /jobs/ via popup, cas aléatoires), 10 captures consécutives sans échec sec.

## 10. Phasage

| Phase | Contenu |
|---|---|
| 1a | Capture LinkedIn (couverture + 3 étages + suppression du reload hack) + capture universelle popup + dual-auth `parse-ai-import`. |
| 1b | Moteur Auto Apply : scan de formulaire, liaison job, mapping local + `ats-apply-map`, UX inline, pièces jointes, quotas. ATS : Greenhouse, Lever, SmartRecruiters, Ashby, Recruitee. |
| 2 | Adapter Workday (wizard multi-pages, création de compte). |
| Explo | Ticket "direct send" app → page de candidature. |
