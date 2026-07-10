# Phase 1a.0 + 1a : fondations backend + capture LinkedIn fiable

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plus jamais d'échec sec de capture : extraction DOM validée par plausibilité, filet IA serveur, capture universelle popup, télémétrie dom/ai et alertes.

**Architecture:** Deux repos. Côté `job-swipers` : un endpoint `parse-job-page` (wrapper de `extractJobFromText` paramétré), un endpoint `profile`, la colonne `extraction_method` + la table `auto_apply_sessions` (migration unique), et un évaluateur d'alertes planifié single-fire. Côté `jobswiper-extension` : un helper partagé de plausibilité/strip PII, un étage filet IA branché aux 5 call-sites de la garde d'extraction, un bouton popup "Save this page", et la première infra de test du repo.

**Tech Stack:** Next.js API routes (dual-auth Bearer + service-role, pattern import-job), Supabase (migration SQL, cron Vercel), extension MV3 vanilla JS (pas de build step), node:test + Playwright pour l'extension.

**Spec source:** `docs/superpowers/specs/2026-07-10-linkedin-capture-auto-apply-design.md` (v6). Ce plan couvre UNIQUEMENT les phases 1a.0 et 1a. Les phases 1b (moteur Auto Apply) et 1c (conformité/Store) auront leurs propres plans.

## Global Constraints

- JAMAIS d'em dash ni d'en dash dans le code, les commentaires, la copy, les commits.
- Copy UI extension en anglais en 1a (l'i18n FR/EN arrive en 1b) ; cohérente avec l'existant ("Save to JobSwiper").
- Couleur brand : bleu `#0064be` pour tout NOUVEAU chrome UI (l'existant navy `#1e3a5f` ne se retouche pas dans cette phase).
- Repo `job-swipers` : commit UNIQUEMENT si `npm run build` sort en exit 0 ; stage par chemins explicites, jamais `git add -A`.
- Migration : `npx supabase db push --linked --dry-run` AVANT `npx supabase db push --linked`, puis `npx supabase migration list --linked` (timestamp visible dans LOCAL et REMOTE). Une seule session pousse des migrations à la fois.
- Texte de page envoyé à l'IA : tronqué à 15 000 caractères, APRÈS strip PII (emails, téléphones, URLs de profil), uniquement sur action explicite.
- Validation de plausibilité : titre non vide ET company non vide ET description > 200 caractères. S'applique aussi au résultat du filet IA.
- Le SW extension ne fetch QUE `https://www.jobswiper.ai`.
- Prérequis rollout prod de 1a (hors code, à rappeler dans la PR) : DPIA capture + TIA premier jet validés, test de configuration ZDR en place (spec section 8 ; le test ZDR arrive avec l'edge function en 1b, en 1a le modèle utilisé par `job-text-extraction` est vérifié manuellement et noté dans la PR).

---

## PARTIE A : job-swipers (phase 1a.0)

### Task 1: Paramétrer `extractJobFromText` avec une opération de télémétrie

**Files:**
- Modify: `src/lib/job-import/extractor.ts:162` (signature) et lignes 217, 239, 259, 287 (les 4 appels `logAIUsageBackground`)

**Interfaces:**
- Produces: `extractJobFromText(jobText: string, userId?: string, operation?: string): Promise<JobExtractionResult>` ; défaut `operation = 'job-text-extraction'` (aucun changement de comportement pour l'appelant existant `src/lib/actions/jobs.ts:1172`).

- [ ] **Step 1: Modifier la signature**

```typescript
export async function extractJobFromText(
  jobText: string,
  userId?: string,
  operation: string = 'job-text-extraction'
): Promise<JobExtractionResult> {
```

- [ ] **Step 2: Remplacer les 4 littéraux**

Aux lignes 217, 239, 259 et 287, remplacer `operation: 'job-text-extraction',` par `operation,`. Le `loadPrompt('job-text-extraction')` ligne 179 ne change PAS (slug de prompt, pas opération d'usage).

- [ ] **Step 3: Vérifier**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/job-import/extractor.ts
git commit -m "refactor(job-import): parametrize usage operation in extractJobFromText"
```

### Task 2: `checkQuotaWithClient` (quota utilisable sous Bearer)

**Files:**
- Modify: `src/lib/ai/quotas.ts` (`checkQuota` l.158, `loadQuotaConfig` l.128)

**Interfaces:**
- Produces: `checkQuotaWithClient(db: SupabaseClient, userId: string, operation: string): Promise<QuotaResult>` ; `checkQuota(userId, operation)` inchangé pour tous les appelants existants.

- [ ] **Step 1: Threader un client optionnel**

Dans `checkQuota`, remplacer la création du client (l.162) :

```typescript
export async function checkQuota(
  userId: string,
  operation: string,
  client?: SupabaseClient
): Promise<QuotaResult> {
  const supabase = client ?? (await createClient())
```

Dans `loadQuotaConfig` (l.128), même motif : `async function loadQuotaConfig(client?: SupabaseClient)` avec `const supabase = client ?? (await createClient())`, et passer `supabase` à l'appel `loadQuotaConfig(supabase)` dans `checkQuota` (l.213). `resolveUserTier(supabase, userId)` reçoit déjà le client (l.214), rien à changer. Vérifier par lecture que TOUTES les requêtes de `checkQuota` utilisent la variable `supabase` (pas de `createClient()` résiduel dans le corps).

Import du type en tête de fichier si absent : `import type { SupabaseClient } from '@supabase/supabase-js'`.

- [ ] **Step 2: Exporter le wrapper**

À la fin du fichier :

```typescript
// Bearer-path quota check: import-job style routes must pass their
// service-role client, the cookie client is blind under Bearer auth (RLS).
export function checkQuotaWithClient(
  db: SupabaseClient,
  userId: string,
  operation: string
): Promise<QuotaResult> {
  return checkQuota(userId, operation, db)
}
```

- [ ] **Step 3: Vérifier + commit**

Run: `npx tsc --noEmit` puis :

```bash
git add src/lib/ai/quotas.ts
git commit -m "feat(quotas): checkQuotaWithClient for Bearer-path routes"
```

### Task 3: Migration (extraction_method, auto_apply_sessions, consentement)

**Files:**
- Create: `supabase/migrations/20260710190000_extension_capture_foundations.sql`

**Interfaces:**
- Produces: colonne `public.jobs.extraction_method text` ; table `public.auto_apply_sessions` (utilisée en 1b, créée ici per phasage spec) ; colonnes `profiles.auto_apply_consent_at` + `profiles.auto_apply_art9_consent_at` ; 3 lignes `platform_alert_config`.

- [ ] **Step 1: Écrire la migration**

```sql
-- Extension capture foundations (spec 2026-07-10 v6, phase 1a.0)
-- 1) jobs.extraction_method: telemetry dom vs ai (circuit-breaker denominator)
-- 2) auto_apply_sessions: quota unit = one application (used from 1b)
-- 3) profiles consent columns (checked server-side by ats-apply-map in 1b)
-- 4) platform_alert_config rows for the scheduled evaluator

alter table public.jobs
  add column if not exists extraction_method text
  check (extraction_method in ('dom', 'ai') or extraction_method is null);

create table if not exists public.auto_apply_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  hostname text not null,
  job_id uuid references public.jobs (id) on delete set null,
  call_count integer not null default 0,
  billed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, hostname, job_id)
);

alter table public.auto_apply_sessions enable row level security;

create policy "auto_apply_sessions_owner_select"
  on public.auto_apply_sessions for select
  using (auth.uid() = user_id);

alter table public.profiles
  add column if not exists auto_apply_consent_at timestamptz,
  add column if not exists auto_apply_art9_consent_at timestamptz;

insert into public.platform_alert_config (alert_type, threshold, is_enabled)
values
  ('extension_ia_fallback_rate', 40, true),
  ('extension_ia_volume_hourly', 100, true),
  ('extension_daily_cost', 5, true)
on conflict do nothing;
```

Note : `extension_ia_fallback_rate` en pourcentage (40 = 40 % de bascules IA sur l'heure), `extension_ia_volume_hourly` en nombre d'appels, `extension_daily_cost` en USD.

- [ ] **Step 2: Dry-run puis push**

Run: `npx supabase db push --linked --dry-run` (vérifier que SEUL ce fichier apparaît ; si une migration d'une autre session traîne, STOP et coordonner).
Run: `npx supabase db push --linked`
Run: `npx supabase migration list --linked`
Expected: `20260710190000` visible dans LOCAL et REMOTE.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260710190000_extension_capture_foundations.sql
git commit -m "feat(db): extension capture foundations (extraction_method, auto_apply_sessions, consent)"
```

### Task 4: `import-job` accepte `extraction_method`

**Files:**
- Modify: `src/app/api/extension/import-job/route.ts` (parse du body vers l.139, insert `jobs` l.251-268)

**Interfaces:**
- Consumes: colonne `jobs.extraction_method` (Task 3).
- Produces: le body accepte `extraction_method?: 'dom' | 'ai'` ; il est persisté à l'INSERT du job (pas à l'update d'un job existant : la méthode d'origine ne se réécrit pas).

- [ ] **Step 1: Parser le champ**

Après le bloc de parse existant (vers l.139) :

```typescript
const extractionMethod =
  body.extraction_method === 'dom' || body.extraction_method === 'ai'
    ? body.extraction_method
    : null
```

- [ ] **Step 2: L'ajouter à l'insert**

Dans l'objet d'insert `jobs` (l.251-268), ajouter :

```typescript
extraction_method: extractionMethod,
```

- [ ] **Step 3: Vérifier + commit**

Run: `npx tsc --noEmit`

```bash
git add src/app/api/extension/import-job/route.ts
git commit -m "feat(extension-api): accept extraction_method on import-job"
```

### Task 5: Route `/api/extension/parse-job-page`

**Files:**
- Create: `src/app/api/extension/parse-job-page/route.ts`

**Interfaces:**
- Consumes: `extractJobFromText(text, userId, 'extension-page-extraction')` (Task 1), `checkQuotaWithClient` (Task 2), pattern dual-auth + CORS + service-role d'`import-job`.
- Produces: `POST { page_text: string, url: string }` retourne `{ success: true, job: ExtractedJobData, confidence, warnings }` ou `{ success: false, error }`. Opération d'usage : `extension-page-extraction`. Cap Bearer : 50/jour.

- [ ] **Step 1: Écrire la route**

```typescript
import { NextRequest } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'
import { extractJobFromText } from '@/lib/job-import/extractor'
import { checkQuota } from '@/lib/ai/quotas'
import { sanitizeText, sanitizeUrl } from '@/lib/utils/sanitize'
import { captureApiError } from '@/lib/sentry'

export const dynamic = 'force-dynamic'

const OPERATION = 'extension-page-extraction'
const BEARER_DAILY_CAP = 50
const MAX_TEXT_CHARS = 15000

type ServiceDb = ReturnType<typeof createServiceRoleClient>

export async function POST(request: NextRequest) {
  const rate = await checkRateLimit(request, 'standard')
  if (!rate.allowed) return cors({ success: false, error: 'Rate limited' }, 429)

  try {
    const supabase = await createClient()
    let {
      data: { user },
    } = await supabase.auth.getUser()
    let usedBearerToken = false
    if (!user) {
      const authHeader = request.headers.get('authorization')
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7)
        const { data } = await supabase.auth.getUser(token)
        if (data.user) {
          user = data.user
          usedBearerToken = true
        }
      }
    }
    if (!user) return cors({ success: false, error: 'Authentication required' }, 401)

    const db = usedBearerToken ? createServiceRoleClient() : supabase

    const quota = await resolveParseQuota(user.id, db, usedBearerToken)
    if (!quota.allowed) return cors(quota.body, quota.status)

    const body = await request.json()
    const pageText = sanitizeText(String(body.page_text ?? '')).slice(0, MAX_TEXT_CHARS)
    const pageUrl = sanitizeUrl(String(body.url ?? ''))
    if (pageText.length < 200) {
      return cors({ success: false, error: 'Not enough page text to extract a job' }, 400)
    }

    const result = await extractJobFromText(pageText, user.id, OPERATION)
    if (!result.success || !result.job) {
      return cors({ success: false, error: result.error ?? 'Extraction failed' }, 422)
    }
    // Plausibility applies to the AI result too (spec section 3)
    const job = result.job
    if (!job.title || !job.company || (job.description ?? '').length <= 200) {
      return cors({ success: false, error: 'Extracted job is implausible' }, 422)
    }
    if (!job.url && pageUrl) job.url = pageUrl

    return cors({ success: true, job, confidence: result.confidence, warnings: result.warnings }, 200)
  } catch (err) {
    captureApiError('extension.parse-job-page', err, {})
    return cors({ success: false, error: 'Internal error' }, 500)
  }
}

async function resolveParseQuota(
  userId: string,
  db: ServiceDb | Awaited<ReturnType<typeof createClient>>,
  usedBearerToken: boolean
): Promise<
  { allowed: true } | { allowed: false; body: Record<string, unknown>; status: number }
> {
  if (!usedBearerToken) {
    const q = await checkQuota(userId, OPERATION)
    if (!q.allowed) {
      return { allowed: false, body: { success: false, error: 'Quota exceeded' }, status: 429 }
    }
    return { allowed: true }
  }
  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)
  const { count } = await db
    .from('ai_usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('operation', OPERATION)
    .eq('success', true)
    .gte('created_at', since.toISOString())
  if ((count ?? 0) >= BEARER_DAILY_CAP) {
    return {
      allowed: false,
      body: { success: false, error: 'Daily smart-extraction limit reached' },
      status: 429,
    }
  }
  return { allowed: true }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function cors(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders() })
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() })
}
```

Ajustements attendus à l'implémentation : vérifier les exports réels de `@/lib/utils/sanitize` (si `sanitizeText`/`sanitizeUrl` ont d'autres noms, reprendre ceux qu'utilise import-job l.105-139) et la signature réelle de `checkRateLimit` (copier l'appel exact de `stats/route.ts:19-22`). `extractJobFromText` logge déjà l'usage lui-même (Task 1), la route ne double-logge pas.

- [ ] **Step 2: Smoke test jetable contre la stack locale**

`npm run test:start` + `npm run test:reset` si la stack n'est pas déjà up. Créer `test/e2e/parse-job-page-smoke.mjs` (SUPPRIMÉ après validation, per conventions repo) :

```javascript
// Jetable: valide parse-job-page en Bearer contre la stack locale.
import { printHarnessEnv } from '../lib/playwright-auth.mjs'
printHarnessEnv()
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ email: 'yoann.abriel@gmail.com', password: 'test123' }),
})
const { access_token } = await login.json()
const res = await fetch(`${BASE_URL}/api/extension/parse-job-page`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
  body: JSON.stringify({
    url: 'https://example.com/job/123',
    page_text: `Senior Product Designer at Acme Corp. Paris, France. Full-time.
We are looking for a senior product designer to join our team of 40 people.
You will own the design system, run user research, and ship features end to end.
Requirements: 5+ years of product design, Figma mastery, strong communication.
Benefits: remote friendly, health insurance, yearly offsite. Salary 60-75k EUR.`,
  }),
})
const json = await res.json()
console.log(res.status, JSON.stringify(json, null, 2))
if (res.status !== 200 || !json.success || !json.job?.title) process.exit(1)
console.log('SMOKE PASS')
```

Run: `BASE_URL=http://localhost:3000 node test/e2e/parse-job-page-smoke.mjs` (dev server `npm run dev:local` lancé).
Expected: `SMOKE PASS` avec un job structuré (title contient "Designer", company "Acme").
Puis : `rm test/e2e/parse-job-page-smoke.mjs`.

- [ ] **Step 3: Vérifier + commit**

Run: `npx tsc --noEmit && npm run build` (exit 0 obligatoire).

```bash
git add src/app/api/extension/parse-job-page/route.ts
git commit -m "feat(extension-api): parse-job-page AI extraction endpoint (dual-auth)"
```

### Task 6: Route `/api/extension/profile`

**Files:**
- Create: `src/app/api/extension/profile/route.ts`

**Interfaces:**
- Consumes: pattern GET de `stats/route.ts` (rate-limit, dual-auth, `cors`).
- Produces: `GET` retourne `{ success: true, profile: {...}, completeness: { ready: boolean, has_name, has_experience } }`. Plafonds : 5 expériences, 5 formations, summary tronqué à 1200 caractères. Inclut `preferred_locale`.

- [ ] **Step 1: Écrire la route**

```typescript
import { NextRequest } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rate-limit'
import { captureApiError } from '@/lib/sentry'

export const dynamic = 'force-dynamic'

const MAX_ITEMS = 5
const MAX_SUMMARY = 1200

export async function GET(request: NextRequest) {
  const rate = await checkRateLimit(request, 'standard')
  if (!rate.allowed) return cors({ success: false, error: 'Rate limited' }, 429)
  try {
    const supabase = await createClient()
    let {
      data: { user },
    } = await supabase.auth.getUser()
    let usedBearerToken = false
    if (!user) {
      const authHeader = request.headers.get('authorization')
      if (authHeader?.startsWith('Bearer ')) {
        const { data } = await supabase.auth.getUser(authHeader.slice(7))
        if (data.user) {
          user = data.user
          usedBearerToken = true
        }
      }
    }
    if (!user) return cors({ success: false, error: 'Authentication required' }, 401)
    const db = usedBearerToken ? createServiceRoleClient() : supabase

    const { data: p, error } = await db
      .from('profiles')
      .select(
        'full_name, email, phone, location, headline, summary, linkedin, website, github, skills, experience, education, certifications, languages, preferred_locale'
      )
      .eq('user_id', user.id)
      .single()
    if (error || !p) return cors({ success: false, error: 'Profile not found' }, 404)

    const experience = (Array.isArray(p.experience) ? p.experience : []).slice(0, MAX_ITEMS)
    const education = (Array.isArray(p.education) ? p.education : []).slice(0, MAX_ITEMS)
    const hasName = Boolean(p.full_name?.trim())
    const hasExperience = experience.length > 0

    return cors({
      success: true,
      profile: {
        full_name: p.full_name ?? '',
        email: p.email ?? '',
        phone: p.phone ?? '',
        location: p.location ?? '',
        headline: p.headline ?? '',
        summary: (p.summary ?? '').slice(0, MAX_SUMMARY),
        linkedin: p.linkedin ?? '',
        website: p.website ?? '',
        github: p.github ?? '',
        skills: Array.isArray(p.skills) ? p.skills : [],
        experience,
        education,
        certifications: (Array.isArray(p.certifications) ? p.certifications : []).slice(0, MAX_ITEMS),
        languages: Array.isArray(p.languages) ? p.languages : [],
        locale: p.preferred_locale ?? 'en',
      },
      completeness: { ready: hasName && hasExperience, has_name: hasName, has_experience: hasExperience },
    })
  } catch (err) {
    captureApiError('extension.profile', err, {})
    return cors({ success: false, error: 'Internal error' }, 500)
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}
function cors(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders() })
}
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() })
}
```

Ajustement attendu : vérifier si la clé du profil est `user_id` ou `id` dans `profiles` (regarder ce que fait `stats/route.ts:74-77` et reprendre exactement le même `.eq`).

- [ ] **Step 2: Vérifier + commit**

Run: `npx tsc --noEmit && npm run build`

```bash
git add src/app/api/extension/profile/route.ts
git commit -m "feat(extension-api): dedicated profile endpoint with completeness"
```

### Task 7: Évaluateur d'alertes planifié (cron, single-fire)

**Files:**
- Create: `src/app/api/cron/check-alerts/route.ts`
- Modify: `vercel.json` (array `crons`)

**Interfaces:**
- Consumes: lignes `platform_alert_config` (Task 3), colonne `jobs.extraction_method` (Task 3), `ai_usage_logs` (operation `extension-page-extraction`).
- Produces: évaluation horaire des 3 types `extension_*`, single-fire via `last_triggered_at`, insertion dans `platform_alerts`.

- [ ] **Step 1: Écrire la route cron**

```typescript
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const now = new Date()
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString()
  const dayAgo = new Date(now.getTime() - 86400_000).toISOString()

  const { data: configs } = await db
    .from('platform_alert_config')
    .select('id, alert_type, threshold, is_enabled, last_triggered_at')
    .in('alert_type', ['extension_ia_fallback_rate', 'extension_ia_volume_hourly', 'extension_daily_cost'])
    .eq('is_enabled', true)

  const results: Record<string, unknown>[] = []
  for (const cfg of configs ?? []) {
    // single-fire: skip if already triggered inside the current window
    const windowStart = cfg.alert_type === 'extension_daily_cost' ? dayAgo : hourAgo
    if (cfg.last_triggered_at && cfg.last_triggered_at > windowStart) continue

    let value = 0
    if (cfg.alert_type === 'extension_ia_fallback_rate') {
      const [{ count: ai }, { count: dom }] = await Promise.all([
        db.from('jobs').select('id', { count: 'exact', head: true }).eq('extraction_method', 'ai').gte('created_at', hourAgo),
        db.from('jobs').select('id', { count: 'exact', head: true }).eq('extraction_method', 'dom').gte('created_at', hourAgo),
      ])
      const total = (ai ?? 0) + (dom ?? 0)
      value = total === 0 ? 0 : Math.round(((ai ?? 0) / total) * 100)
    } else if (cfg.alert_type === 'extension_ia_volume_hourly') {
      const { count } = await db
        .from('ai_usage_logs').select('id', { count: 'exact', head: true })
        .eq('operation', 'extension-page-extraction').gte('created_at', hourAgo)
      value = count ?? 0
    } else if (cfg.alert_type === 'extension_daily_cost') {
      const { data } = await db
        .from('ai_usage_logs').select('estimated_cost_usd')
        .eq('operation', 'extension-page-extraction').gte('created_at', dayAgo)
      value = (data ?? []).reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0)
    }

    const exceeded = value > Number(cfg.threshold)
    results.push({ type: cfg.alert_type, value, threshold: cfg.threshold, exceeded })
    if (exceeded) {
      await db.from('platform_alerts').insert({
        alert_type: cfg.alert_type,
        message: `${cfg.alert_type}: ${value} exceeds threshold ${cfg.threshold}`,
      })
      await db.from('platform_alert_config').update({ last_triggered_at: now.toISOString() }).eq('id', cfg.id)
    }
  }
  return Response.json({ checked: results.length, results })
}
```

Ajustement attendu : vérifier les colonnes réelles de `platform_alerts` dans la baseline (adapter l'insert : certains schémas ont `severity`/`details jsonb`).

- [ ] **Step 2: Enregistrer le cron**

Dans `vercel.json`, ajouter à l'array `crons` :

```json
{ "path": "/api/cron/check-alerts", "schedule": "0 * * * *" }
```

- [ ] **Step 3: Tester localement**

Run: `curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/check-alerts | head -c 400` (dev:local, CRON_SECRET de `.env.local.local`).
Expected: JSON `{ checked: 3, results: [...] }`, aucun `exceeded` sur une base fraîche.

- [ ] **Step 4: Build + commit**

Run: `npm run build` (exit 0).

```bash
git add src/app/api/cron/check-alerts/route.ts vercel.json
git commit -m "feat(alerts): scheduled single-fire evaluator for extension capture metrics"
```

---

## PARTIE B : jobswiper-extension (phase 1a)

### Task 8: Bootstrap de l'infra de test (premier item de 1a)

**Files:**
- Create: `package.json`, `test/unit/.gitkeep`, `test/fixtures/.gitkeep`, `test/protocol/.gitkeep`
- Modify: `.gitignore` (ajouter `node_modules/` déjà présent, vérifier)

**Interfaces:**
- Produces: `npm test` lance node:test sur `test/unit/*.test.mjs` ; Playwright installé pour les tasks suivantes et le protocole.

- [ ] **Step 1: package.json**

```json
{
  "name": "jobswiper-extension",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/unit/",
    "test:protocol": "node test/protocol/capture-run.mjs"
  },
  "devDependencies": {
    "playwright": "^1.49.0"
  }
}
```

Run: `npm install`

- [ ] **Step 2: Vérifier**

Run: `npm test`
Expected: `pass 0` (aucun test encore, exit 0).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json test/unit/.gitkeep test/fixtures/.gitkeep test/protocol/.gitkeep .gitignore
git commit -m "chore(test): bootstrap node:test + playwright harness"
```

### Task 9: Helper partagé plausibilité + strip PII + collecte de texte (TDD)

**Files:**
- Create: `utils/extract-helpers.js`
- Test: `test/unit/extract-helpers.test.mjs`
- Modify: `manifest.json` (charger `utils/extract-helpers.js` avant chaque content script de site d'emploi, comme `utils/match.js`)

**Interfaces:**
- Produces: `window.JobSwiperExtract = { isPlausibleJob(data), stripPII(text), collectPageText(maxChars) }`. Chargé dans les 4 content scripts de sites d'emploi. `isPlausibleJob` : title ET company non vides ET description > 200. `stripPII` : retire emails, numéros de téléphone (formats FR/CH/intl courants), URLs linkedin.com/in/.
- Le fichier s'exporte AUSSI en module node pour les tests : garde `typeof module !== 'undefined'`.

- [ ] **Step 1: Écrire les tests qui échouent**

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlausibleJob, stripPII } from '../../utils/extract-helpers.js'

const LONG = 'x'.repeat(250)

test('plausible: title+company+long description', () => {
  assert.equal(isPlausibleJob({ title: 'Designer', company: 'Acme', description: LONG }), true)
})
test('implausible: empty title', () => {
  assert.equal(isPlausibleJob({ title: '', company: 'Acme', description: LONG }), false)
})
test('implausible: short description', () => {
  assert.equal(isPlausibleJob({ title: 'Designer', company: 'Acme', description: 'too short' }), false)
})
test('stripPII removes emails, phones, profile urls', () => {
  const input =
    'Contact jane.doe@acme.com or +41 78 605 70 60 or 06 52 05 59 47, profile https://www.linkedin.com/in/jane-doe/'
  const out = stripPII(input)
  assert.ok(!out.includes('jane.doe@acme.com'))
  assert.ok(!out.includes('78 605 70 60'))
  assert.ok(!out.includes('06 52 05 59 47'))
  assert.ok(!out.includes('linkedin.com/in/'))
})
```

Run: `npm test`
Expected: FAIL (module inexistant).

- [ ] **Step 2: Implémenter**

```javascript
/**
 * JobSwiper shared extraction helpers.
 * Loaded as a plain script in content scripts (window.JobSwiperExtract)
 * and importable in node for tests.
 */
(function (root) {
  function isPlausibleJob(data) {
    if (!data) return false
    const title = (data.title || '').trim()
    const company = (data.company || '').trim()
    const description = (data.description || '').trim()
    return title.length > 0 && company.length > 0 && description.length > 200
  }

  const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
  const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g
  const PROFILE_URL_RE = /https?:\/\/[^\s]*linkedin\.com\/in\/[^\s]*/gi

  function stripPII(text) {
    return String(text || '')
      .replace(EMAIL_RE, '[email]')
      .replace(PROFILE_URL_RE, '[profile]')
      .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m))
  }

  function collectPageText(maxChars) {
    const max = maxChars || 15000
    const containers = [
      '.jobs-description-content__text',
      '#job-details',
      '[class*="jobs-description"]',
      'main',
      'body',
    ]
    let text = ''
    for (const sel of containers) {
      const el = typeof document !== 'undefined' ? document.querySelector(sel) : null
      if (el && el.innerText && el.innerText.trim().length > 400) {
        text = el.innerText
        break
      }
    }
    if (!text && typeof document !== 'undefined') text = document.body?.innerText || ''
    return stripPII(text).slice(0, max)
  }

  const api = { isPlausibleJob, stripPII, collectPageText }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.JobSwiperExtract = api
})(typeof window !== 'undefined' ? window : null)
```

Note ESM/CJS : le repo est `"type": "module"`, donc le test importe via `import ... from '../../utils/extract-helpers.js'` qui échouera sur `module.exports`. Solution retenue : renommer la copie module en export nommé via un petit wrapper : créer `test/unit/_helpers-cjs.cjs` N'EST PAS nécessaire si on ajoute en fin de fichier :

```javascript
export const isPlausibleJob = api.isPlausibleJob
```

INTERDIT : un fichier content script MV3 ne peut pas contenir `export`. Trancher ainsi : le fichier reste un script classique SANS export ; le test le charge via `createRequire` :

```javascript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { isPlausibleJob, stripPII } = require('../../utils/extract-helpers.js')
```

et `utils/extract-helpers.js` garde uniquement la garde `typeof module !== 'undefined'`. Ajouter un fichier `utils/package.json` contenant `{ "type": "commonjs" }` pour que `require` fonctionne malgré le `"type": "module"` racine.

- [ ] **Step 3: Vérifier**

Run: `npm test`
Expected: 4 tests PASS.

- [ ] **Step 4: Charger dans le manifest**

Dans `manifest.json`, ajouter `"utils/extract-helpers.js"` en tête des arrays `js` des 4 blocs content scripts de sites d'emploi (Indeed, LinkedIn isolé, jobup/jobs.ch, wttj), juste avant `utils/match.js`.

- [ ] **Step 5: Commit**

```bash
git add utils/extract-helpers.js utils/package.json test/unit/extract-helpers.test.mjs manifest.json
git commit -m "feat(extract): shared plausibility + PII-strip helpers (TDD)"
```

### Task 10: Handler `PARSE_JOB_PAGE` dans le background

**Files:**
- Modify: `background.js` (switch du dispatcher, ajouter le case avant `default` vers la ligne 323)

**Interfaces:**
- Consumes: `getValidToken()`, `fetchWithTimeout`, `API_BASE` (existants).
- Produces: message `{ type: 'PARSE_JOB_PAGE', pageText, url }` répond `{ success, job?, error? }`. Timeout 20 s (l'appel IA est plus lent qu'un save).

- [ ] **Step 1: Ajouter le case**

```javascript
case 'PARSE_JOB_PAGE': {
  const token = await getValidToken()
  if (!token) {
    sendResponse({ success: false, error: 'Not authenticated' })
    return
  }
  const response = await fetchWithTimeout(
    `${API_BASE}/api/extension/parse-job-page`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ page_text: message.pageText, url: message.url }),
    },
    20000
  )
  const json = await response.json()
  sendResponse(json)
  return
}
```

- [ ] **Step 2: Vérifier manuellement**

Charger l'extension unpacked (`chrome://extensions`), ouvrir le service worker inspect, exécuter dans la console :

```javascript
chrome.runtime.sendMessage({ type: 'PARSE_JOB_PAGE', pageText: 'Senior Designer at Acme. '.repeat(20), url: 'https://example.com/j/1' }, console.log)
```

Expected: `{success: true, job: {...}}` (connecté) ou `{success: false, error: 'Not authenticated'}` (déconnecté). Les deux prouvent le câblage.

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "feat(background): PARSE_JOB_PAGE message for AI extraction fallback"
```

### Task 11: 3 étages dans linkedin.js + extraction_method + flag reload hack

**Files:**
- Modify: `content/linkedin.js` : `handleSave` (garde l.243-247), `autoImportCurrentJob` (garde l.223), `extractJobData` retour (l.198), reload hack (l.547-572)

**Interfaces:**
- Consumes: `window.JobSwiperExtract` (Task 9), message `PARSE_JOB_PAGE` (Task 10).
- Produces: tout job sauvé porte `extraction_method: 'dom' | 'ai'` ; plus aucun chemin "Could not extract" sec tant que le filet IA peut tenter ; le reload hack est désactivable via `chrome.storage.local.disableReloadHack` (pour la variante du protocole).

- [ ] **Step 1: Helper de fallback partagé dans le fichier**

Ajouter au-dessus de `handleSave` :

```javascript
// Stage 3: AI net. Returns a plausible jobData or null.
async function aiExtractFallback() {
  const pageText = window.JobSwiperExtract.collectPageText(15000)
  if (pageText.length < 200) return null
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'PARSE_JOB_PAGE',
      pageText,
      url: window.location.href,
    })
    if (!res?.success || !res.job) return null
    const job = { ...res.job, source: 'linkedin', extraction_method: 'ai' }
    // keep the canonical LinkedIn url when we have a job id
    const id = getLinkedInJobId()
    if (id) job.url = `https://www.linkedin.com/jobs/view/${id}/`
    return window.JobSwiperExtract.isPlausibleJob(job) ? job : null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Brancher dans handleSave**

Remplacer la garde lignes 243-247 par :

```javascript
let effectiveJob = jobData
if (!window.JobSwiperExtract.isPlausibleJob(jobData)) {
  btn.innerHTML = '<div class="spinner"></div> Smart extraction...'
  effectiveJob = await aiExtractFallback()
  if (!effectiveJob) {
    btn.innerHTML = '⚠️ Could not extract, open the job page and retry'
    setTimeout(() => resetButton(btn), 3000)
    return
  }
} else {
  effectiveJob.extraction_method = 'dom'
}
```

et remplacer les usages suivants de `jobData` dans `handleSave` par `effectiveJob` (l'appel SAVE_JOB l.267 devient `{ type: 'SAVE_JOB', data: effectiveJob, token }`).

- [ ] **Step 3: Brancher dans autoImportCurrentJob**

Même motif à la ligne 223 : si implausible, tenter `aiExtractFallback()` ; si null, retourner `{ success: false, error: 'No job data on this page' }` ; sinon poser `extraction_method` et continuer.

- [ ] **Step 4: Flag du reload hack**

En tête du bloc `_reloadTimer` (l.548), ajouter :

```javascript
const { disableReloadHack } = await chrome.storage.local.get('disableReloadHack')
if (disableReloadHack) { clearInterval(_reloadTimer); return }
```

(le callback du setInterval devient async).

- [ ] **Step 5: Vérification manuelle sur LinkedIn réel**

Extension unpacked rechargée. Sur une page `/jobs/view/` : sauvegarder un job normal (badge réseau : vérifier dans l'onglet Network du SW que `import-job` part avec `extraction_method: 'dom'`). Puis simuler l'échec DOM : dans la console de la page, exécuter `document.querySelector('.jobs-description-content__text')?.remove()` avant de cliquer Save ; le bouton doit passer par "Smart extraction..." et sauvegarder (extraction_method 'ai') ou afficher le message d'échec propre.

- [ ] **Step 6: Commit**

```bash
git add content/linkedin.js
git commit -m "feat(linkedin): 3-stage extraction with AI fallback + extraction_method + reload-hack flag"
```

### Task 12: Même garde 3 étages dans indeed.js, wttj.js, jobup.js

**Files:**
- Modify: `content/indeed.js` (garde l.182-186 et autoImport l.274-275), `content/wttj.js` (garde l.186-187), `content/jobup.js` (garde l.234-235)

**Interfaces:**
- Consumes: `window.JobSwiperExtract` (chargé par le manifest, Task 9), message `PARSE_JOB_PAGE`.
- Produces: les 3 sites suivent le même contrat 3 étages ; `source` reste celui du site (`indeed`, `wttj`, `jobup`), `extraction_method` posé partout.

- [ ] **Step 1: Répliquer le motif**

Dans chacun des 3 fichiers, ajouter la même fonction `aiExtractFallback()` que Task 11 Step 1 MAIS avec le `source` du fichier et sans la canonicalisation LinkedIn (garder `job.url = window.location.href` si le job IA n'a pas d'URL) :

```javascript
async function aiExtractFallback(sourceName) {
  const pageText = window.JobSwiperExtract.collectPageText(15000)
  if (pageText.length < 200) return null
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'PARSE_JOB_PAGE',
      pageText,
      url: window.location.href,
    })
    if (!res?.success || !res.job) return null
    const job = { ...res.job, source: sourceName, extraction_method: 'ai' }
    if (!job.url) job.url = window.location.href
    return window.JobSwiperExtract.isPlausibleJob(job) ? job : null
  } catch {
    return null
  }
}
```

Puis remplacer chaque garde `if (!jobData.title || !jobData.company) { ... }` par le bloc de Task 11 Step 2 (avec `aiExtractFallback('indeed')` / `'wttj'` / `'jobup'`), et poser `extraction_method = 'dom'` sur le chemin nominal. wttj : attention au paramètre `jobDataOverride` (l.181) ; la plausibilité s'applique au jobData EFFECTIF (override inclus).

- [ ] **Step 2: Vérification manuelle rapide**

Un save nominal sur Indeed (extraction_method 'dom' dans le payload réseau). Pas besoin de forcer le fallback sur les 3 sites : le chemin est identique à celui testé en Task 11.

- [ ] **Step 3: Commit**

```bash
git add content/indeed.js content/wttj.js content/jobup.js
git commit -m "feat(sites): 3-stage extraction guard on indeed, wttj, jobup"
```

### Task 13: Popup "Save this page" (capture universelle)

**Files:**
- Modify: `popup/popup.html` (dans `#main-section`, avant le divider l.91), `popup/popup.js`

**Interfaces:**
- Consumes: `PARSE_JOB_PAGE` + `SAVE_JOB` (background), `chrome.scripting.executeScript` (permission déjà présente), `chrome.tabs.query`.
- Produces: bouton `#save-page-btn` : collecte le texte de l'onglet actif (allFrames, meilleur frame = texte le plus long), porte de plausibilité à DEUX seuils (score par mots-clés : bloqué < 2, avertissement < 4), désactivé sur les surfaces LinkedIn exclues, mention first-run (`chrome.storage.local.pageCapNoticeShown`).

- [ ] **Step 1: HTML**

```html
<button id="save-page-btn" class="btn" style="width:100%;margin:8px 0;background:#0064be;color:#fff;">
  Save this page to JobSwiper
</button>
<div id="save-page-status" style="font-size:12px;color:#666;margin-bottom:6px;"></div>
```

- [ ] **Step 2: JS**

```javascript
const EXCLUDED_LINKEDIN = /linkedin\.com\/(feed|messaging|notifications|mynetwork)/
const JOB_SIGNALS = [
  /apply|postuler|candidature/i,
  /salary|salaire|compensation/i,
  /requirements|qualifications|profil recherch/i,
  /full[- ]?time|part[- ]?time|cdi|cdd|temps plein/i,
  /responsibilit|missions|about the role|votre r[oô]le/i,
  /experience|exp[eé]rience/i,
]

function plausibilityScore(text) {
  return JOB_SIGNALS.reduce((s, re) => s + (re.test(text) ? 1 : 0), 0)
}

async function collectActiveTabText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url?.startsWith('http')) return { error: 'This page cannot be captured' }
  if (EXCLUDED_LINKEDIN.test(tab.url)) {
    return { error: 'Not available on LinkedIn feed, messages or notifications. Open the job page itself.' }
  }
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => document.body?.innerText?.slice(0, 20000) || '',
  })
  const best = frames.map((f) => f.result || '').sort((a, b) => b.length - a.length)[0] || ''
  return { tab, text: best }
}

document.getElementById('save-page-btn').addEventListener('click', async () => {
  const status = document.getElementById('save-page-status')
  const btn = document.getElementById('save-page-btn')
  status.textContent = ''
  const { tab, text, error } = await collectActiveTabText()
  if (error) { status.textContent = error; return }

  const score = plausibilityScore(text)
  if (score < 2) { status.textContent = 'This page does not look like a job posting.'; return }
  if (score < 4 && !confirm('This page does not clearly look like a job posting. Send it anyway?')) return

  const { pageCapNoticeShown } = await chrome.storage.local.get('pageCapNoticeShown')
  if (!pageCapNoticeShown) {
    status.textContent = 'Page content is sent to JobSwiper AI to extract the job.'
    await chrome.storage.local.set({ pageCapNoticeShown: true })
  }

  btn.disabled = true
  btn.textContent = 'Extracting...'
  try {
    // PII strip mirrors utils/extract-helpers.js (popup has no content-script context)
    const stripped = text
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
      .replace(/https?:\/\/[^\s]*linkedin\.com\/in\/[^\s]*/gi, '[profile]')
      .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g,
        (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m))
      .slice(0, 15000)
    const parsed = await callSW({ type: 'PARSE_JOB_PAGE', pageText: stripped, url: tab.url }, { timeoutMs: 25000 })
    if (!parsed?.success || !parsed.job) throw new Error(parsed?.error || 'Could not extract a job from this page')
    const token = (await callSW({ type: 'AUTO_CONNECT' }))?.token
    const saved = await callSW({
      type: 'SAVE_JOB',
      data: { ...parsed.job, source: 'page-capture', extraction_method: 'ai', url: parsed.job.url || tab.url },
      token,
    })
    if (!saved?.success) throw new Error(saved?.error || 'Save failed')
    btn.textContent = 'Saved!'
    status.textContent = `${parsed.job.title} at ${parsed.job.company}`
  } catch (e) {
    btn.textContent = 'Save this page to JobSwiper'
    status.textContent = e.message
  } finally {
    btn.disabled = false
    setTimeout(() => { btn.textContent = 'Save this page to JobSwiper' }, 3000)
  }
})
```

Ajustement attendu : `callSW` existe (popup.js:26-41) ; vérifier la forme exacte de la réponse AUTO_CONNECT (`{success, token}`) et celle attendue par SAVE_JOB (`message.token`).

- [ ] **Step 3: Vérification manuelle**

Popup sur : (a) une page d'offre quelconque hors sites supportés : Save this page fonctionne de bout en bout ; (b) linkedin.com/feed : message d'indisponibilité ; (c) une page wikipedia : "does not look like a job posting".

- [ ] **Step 4: Commit**

```bash
git add popup/popup.html popup/popup.js
git commit -m "feat(popup): universal Save this page with plausibility gate"
```

### Task 14: Protocole de capture (script + doc), variante hack désactivé

**Files:**
- Create: `test/protocol/capture-run.mjs`, `test/protocol/README.md`

**Interfaces:**
- Consumes: extension unpacked, flag `disableReloadHack` (Task 11), comptes LinkedIn de TEST dédiés (jamais le compte prod admin).
- Produces: le gate de release : N tentatives (défaut 100) réparties sur détail/recherche/collections/guest, échec sec compté SEULEMENT si ni DOM ni IA n'aboutissent, challenges LinkedIn = SKIP rejoué.

- [ ] **Step 1: Script**

```javascript
// Release-gate protocol: N capture attempts on real LinkedIn surfaces.
// Usage: node test/protocol/capture-run.mjs [N] [--no-reload-hack]
// Requires: PROFILE_DIR env (persistent Chrome profile logged into a TEST account).
import { chromium } from 'playwright'
import path from 'node:path'

const N = Number(process.argv[2] ?? 100)
const noHack = process.argv.includes('--no-reload-hack')
const EXT_PATH = path.resolve(import.meta.dirname, '..', '..')
const PROFILE_DIR = process.env.PROFILE_DIR
if (!PROFILE_DIR) { console.error('Set PROFILE_DIR to a persistent profile dir (TEST account).'); process.exit(1) }

const SURFACES = [
  'https://www.linkedin.com/jobs/search/?keywords=product%20designer',
  'https://www.linkedin.com/jobs/collections/recommended/',
]

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  userAgent: undefined,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
})
const page = await ctx.newPage()
await page.setExtraHTTPHeaders({ 'X-Harness': 'JobswiperSmoke' })

let ok = 0, dryFail = 0, skipped = 0
for (let i = 0; i < N; i++) {
  const url = SURFACES[i % SURFACES.length]
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (page.url().includes('/checkpoint/') || page.url().includes('/authwall')) {
    skipped++; console.log(`[${i}] SKIP challenge`); continue
  }
  if (noHack) {
    await page.evaluate(() => chrome?.storage?.local?.set?.({ disableReloadHack: true })).catch(() => {})
  }
  try {
    const btn = page.locator('.jobswiper-save-btn').first()
    await btn.waitFor({ timeout: 15000 })
    await btn.click()
    await page.locator('.jobswiper-save-btn.saved, .jobswiper-toast').first().waitFor({ timeout: 30000 })
    ok++
    console.log(`[${i}] OK`)
  } catch {
    dryFail++
    console.log(`[${i}] DRY FAIL on ${page.url()}`)
  }
  await page.waitForTimeout(3000 + Math.random() * 4000)
}
console.log(`\nRESULT ok=${ok} dryFail=${dryFail} skipped=${skipped} / ${N} (hack ${noHack ? 'OFF' : 'ON'})`)
process.exit(dryFail === 0 ? 0 : 1)
```

Note : le flag `disableReloadHack` se pose via la console du SW avant le run si l'évaluation in-page échoue (chrome.storage n'est pas toujours accessible depuis le contexte page) ; le README le documente.

- [ ] **Step 2: README du protocole**

```markdown
# Capture protocol (release gate)

- TEST account only. NEVER the prod admin account.
- Baseline BEFORE a selector change, then post-fix run: 0 dry fails / 100.
- LinkedIn challenges (checkpoint/authwall) are SKIPPED and replayed, never counted as failures.
- Variant `--no-reload-hack`: same run with the reload hack disabled. The hack is
  only removed from the codebase when this variant passes clean.
- Run cadence: before each extension release, and after any LinkedIn revamp
  detected via the extraction_method telemetry in /admin.
- A dry fail = neither DOM extraction nor AI fallback produced a save.
```

- [ ] **Step 3: Commit**

```bash
git add test/protocol/capture-run.mjs test/protocol/README.md
git commit -m "test(protocol): LinkedIn capture release gate + no-reload-hack variant"
```

### Task 15: Version bump + PRs

- [ ] **Step 1: Bump extension**

`manifest.json` : `"version": "1.1.0"`.

```bash
git add manifest.json
git commit -m "chore: bump to 1.1.0 (3-stage capture + universal page save)"
```

- [ ] **Step 2: PRs**

Repo `job-swipers` : brancher les commits des Tasks 1-7 sur une branche `feat/yoa-extension-capture-1a0` (créée AVANT le premier commit si la session partage le checkout : suivre la règle worktree du CLAUDE.md), `npm run build` une dernière fois, PR vers main. Rappeler dans la description : prérequis rollout prod = DPIA capture + TIA premier jet (spec v6 section 8) ; migration déjà poussée.

Repo `jobswiper-extension` : PR `feat/capture-3-stages` avec le résultat du protocole (Task 14) collé dans la description. Le paquet Store ne part qu'après la passe 1c (justifications de permissions).

---

## Self-review (faite à l'écriture)

- Couverture spec 1a.0 : parse-job-page (T5), profile (T6), migration sessions+consentement+extraction_method (T3), checkQuotaWithClient (T2), extractJobFromText paramétré (T1), extraction_method sur import-job (T4), alertes planifiées single-fire (T7). Couverture 1a : harnais en premier (T8), 3 étages + plausibilité + minimisation (T9-T12), popup à deux seuils avec exclusions (T13), protocole + variante sans hack (T14). Hors plan (volontairement, spec 1b/1c) : tout Auto Apply, i18n extension, artefacts juridiques.
- Ajustements signalés comme tels dans les tasks (noms exacts de sanitize/rate-limit, clé profiles, colonnes platform_alerts) : à résoudre par lecture du fichier cité, pas des TODO.
- Types cohérents : `extraction_method 'dom'|'ai'` partout ; `OPERATION = 'extension-page-extraction'` unique ; `JobSwiperExtract` unique.
