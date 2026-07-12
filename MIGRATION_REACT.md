# Migration Dashboard — Streamlit → React

## Contexte
- **Durée disponible :** 1 mois
- **Stack cible :** React 19 + Vite 7 + Tailwind 4 + TanStack Query (déjà dans le catalog pnpm)
- **Backend :** Express API inchangé — React remplace uniquement le frontend
- **Streamlit :** archivé dans `cloud-surgeon-agent/old/`

---

## Étape 0 — Archivage Streamlit (Jour 1 matin — 30 min)

```bash
# Déplacer le dashboard Streamlit dans old/
mkdir -p cloud-surgeon-agent/old
mv cloud-surgeon-agent/frontend cloud-surgeon-agent/old/frontend
mv cloud-surgeon-agent/.streamlit cloud-surgeon-agent/old/.streamlit
mv cloud-surgeon-agent/requirements.txt cloud-surgeon-agent/old/requirements.txt

# Garder le schéma DB et les docs — ils ne bougent pas
# cloud-surgeon-agent/database/  → intact
# cloud-surgeon-agent/backend/   → intact (lambda_function.py référence)
```

Arrêter le workflow `Cloud-Surgeon Dashboard` et le reconfigurer
vers `pnpm --filter @workspace/dashboard run dev` une fois le scaffold prêt.

---

## Étape 1 — Scaffold de l'artifact React (Jour 1 après-midi — 2h)

### 1.1 Structure cible dans le monorepo

```
artifacts/
  dashboard/              ← nouvel artifact
    src/
      api/                ← client HTTP + SSE (un fichier par resource)
      components/
        ui/               ← primitives (Badge, Card, Button, Spinner…)
        layout/           ← Sidebar, TabBar, TopBar
        incident/         ← IncidentCard, TurnExpander, ApprovalPanel
        charts/           ← WinRateBar, MttrChart, RoutingPie
      pages/
        JudgeGuide.tsx
        LiveDiagnostic.tsx
        WhyDecision.tsx
        Incidents.tsx
        MemoryWinRates.tsx
        Calibration.tsx
        MttrCost.tsx
        ExecutionLog.tsx
      hooks/
        useIncidents.ts   ← TanStack Query wrapper
        useWinRates.ts
        useAuditStream.ts ← SSE EventSource hook
        useImpact.ts
        useCalibration.ts
        useLogs.ts
      lib/
        api.ts            ← fetch wrapper avec X-API-Key header
        constants.ts      ← PRESET_SCENARIOS, PREDICTIVE_SCENARIOS
        types.ts          ← types TS générés depuis l'API
      App.tsx
      main.tsx
    public/
      favicon.ico         ← copier depuis cloud-surgeon-agent/old/frontend/static/
    index.html
    vite.config.ts
    tailwind.config.ts
    package.json
    tsconfig.json
    .replit-artifact/
      artifact.toml
```

### 1.2 package.json de l'artifact

```json
{
  "name": "@workspace/dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev":   "vite --port $PORT --host 0.0.0.0",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react":                    "catalog:",
    "react-dom":                "catalog:",
    "react-router-dom":         "^7.6.0",
    "@tanstack/react-query":    "^5.80.7",
    "recharts":                 "^2.15.3",
    "lucide-react":             "^0.525.0",
    "clsx":                     "^2.1.1"
  },
  "devDependencies": {
    "@types/react":             "catalog:",
    "@types/react-dom":         "catalog:",
    "@vitejs/plugin-react":     "catalog:",
    "vite":                     "catalog:",
    "tailwindcss":              "catalog:",
    "@tailwindcss/vite":        "catalog:",
    "typescript":               "catalog:"
  }
}
```

### 1.3 artifact.toml

```toml
[artifact]
kind    = "web"
title   = "Cloud-Surgeon Dashboard"
version = "0.1.0"
id      = "dashboard"

[service]
port        = "$PORT"
previewPath = "/dashboard"
runCommand  = "pnpm --filter @workspace/dashboard run dev"
buildCommand = "pnpm --filter @workspace/dashboard run build"
```

---

## Étape 2 — Couche API (Jour 2 — demi-journée)

Tout passe par un fetch wrapper central avec l'auth header.

### 2.1 `src/lib/api.ts`

```typescript
const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";
const KEY  = import.meta.env.VITE_API_KEY ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": KEY,
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  // Health
  healthz: ()                          => request<{ status: string }>("/healthz"),

  // Incidents
  incidents:     ()                    => request<Incident[]>("/incidents"),
  incident:      (id: string)          => request<Incident>(`/incidents/${id}`),
  trigger:       (body: TriggerBody)   => request<Incident>("/incidents/trigger", { method:"POST", body: JSON.stringify(body) }),
  approve:       (id: string)          => request<Incident>(`/incidents/${id}/approve`, { method:"POST" }),
  reject:        (id: string)          => request<Incident>(`/incidents/${id}/reject`,  { method:"POST" }),
  correct:       (id: string, strategy: string) =>
                                          request<Incident>(`/incidents/${id}/correct`, { method:"POST", body: JSON.stringify({ suggestedStrategy: strategy }) }),
  causalChain:   (id: string)          => request<CausalChain>(`/incidents/${id}/causal-chain`),
  handoffs:      (id: string)          => request<Handoff[]>(`/incidents/${id}/handoffs`),

  // Metrics
  winRates:      ()                    => request<WinRate[]>("/metrics/win-rates"),
  impact:        ()                    => request<Impact>("/metrics/impact"),
  calibration:   ()                    => request<Calibration[]>("/metrics/calibration"),
  recalibrate:   ()                    => request<void>("/metrics/calibration/recalibrate", { method:"POST" }),
  ccloud:        (action: string)      => request<unknown>(`/metrics/ccloud?action=${action}`),
  cluster:       ()                    => request<unknown>("/metrics/cluster"),
  ingest:        (datapoints: object[]) => request<unknown>("/metrics/ingest", { method:"POST", body: JSON.stringify(datapoints) }),
  seed:          ()                    => request<unknown>("/metrics/seed", { method:"POST", body: "{}" }),

  // Logs
  logs:          (incidentId?: string) => request<Log[]>(`/logs${incidentId ? `?incidentId=${incidentId}` : ""}`),

  // Actions
  sigkill:       ()                    => request<unknown>("/chaos/sigkill", { method:"POST" }),
  cloudwatch:    (body: object)        => request<unknown>("/webhook/cloudwatch", { method:"POST", body: JSON.stringify(body) }),
};
```

### 2.2 `src/hooks/useAuditStream.ts` — SSE temps réel

```typescript
import { useEffect, useState } from "react";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";
const KEY  = import.meta.env.VITE_API_KEY ?? "";

export interface AuditEvent {
  type: string;
  incidentId: string;
  status: string;
  timestamp: string;
}

export function useAuditStream() {
  const [events, setEvents]     = useState<AuditEvent[]>([]);
  const [cdcLive, setCdcLive]   = useState(false);

  useEffect(() => {
    // EventSource ne supporte pas les headers — on passe la clé en query param
    const url = `${BASE}/stream/audit?apiKey=${KEY}`;
    const es  = new EventSource(url);

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as AuditEvent;
      if (data.type === "cdc") setCdcLive(true);
      setEvents((prev) => [data, ...prev].slice(0, 50));
    };

    es.onerror = () => setCdcLive(false);
    return () => es.close();
  }, []);

  return { events, cdcLive };
}
```

> **Note** : le header `X-API-Key` ne peut pas être envoyé via `EventSource` natif.
> Deux options : (a) passer la clé en query param côté Express (ajout mineur),
> ou (b) utiliser `fetch` avec `ReadableStream` pour le SSE.
> Option (a) recommandée — 5 lignes dans `stream.ts`.

### 2.3 Hooks TanStack Query (pattern uniforme)

```typescript
// src/hooks/useIncidents.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export const useIncidents = () =>
  useQuery({ queryKey: ["incidents"], queryFn: api.incidents, refetchInterval: 3000 });

export const useApprove = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.approve(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incidents"] }),
  });
};

// Même pattern pour useWinRates, useImpact, useCalibration, useLogs
```

---

## Étape 3 — Layout & Navigation (Jour 2 fin — 3h)

### Architecture de navigation

```
App.tsx
├── TopBar          ← logo + badge connexion API + badge CDC 🟢/🔴
├── Sidebar         ← contrôles (trigger, chaos, webhook, predictive)
│   └── collapsible sur mobile
└── MainContent
    └── TabBar      ← 8 onglets (react-router-dom v7 tabs pattern)
        ├── /                → JudgeGuide
        ├── /live            → LiveDiagnostic
        ├── /decision        → WhyDecision
        ├── /incidents       → Incidents
        ├── /memory          → MemoryWinRates
        ├── /calibration     → Calibration
        ├── /impact          → MttrCost
        └── /logs            → ExecutionLog
```

### Design system

Palette Dark (thème "ops center") :
```
Background :  #0a0e1a  (dark navy)
Surface :     #111827  (cards)
Border :      #1f2937
Accent :      #3b82f6  (bleu AWS)
Success :     #10b981  (vert CockroachDB)
Warning :     #f59e0b
Danger :      #ef4444
Text :        #f9fafb
Muted :       #6b7280
```

Badges de statut :
```
TRIGGERED    → 🔵 bleu   pulse animation
DIAGNOSING   → 🟡 jaune  pulse animation
REPAIRING    → 🟠 orange pulse animation
RESOLVED     → 🟢 vert   statique
FAILED       → 🔴 rouge  statique
PENDING_APPROVAL → 🟡 jaune  clignotant
PREDICTIVE   → 🔮 violet statique
```

---

## Étape 4 — Pages (Semaine 1-2)

### Mapping Streamlit → React

| Streamlit | React Page | Composants clés | Refresh |
|---|---|---|---|
| Judge Guide tab | `JudgeGuide.tsx` | Accordion (5 scenarios), 3 colonnes arch | statique |
| Live Diagnostic | `LiveDiagnostic.tsx` | `IncidentProgress`, `TurnExpander`, `AuditFeed` | SSE + 3s |
| Why this decision? | `WhyDecision.tsx` | `IncidentSelect`, `RoutingCard`, `CausalChainTree` | 5s |
| Incidents | `Incidents.tsx` | `IncidentTable`, `ApprovalPanel`, `CorrectStrategy` | 3s |
| Memory & Win-rates | `MemoryWinRates.tsx` | `WinRateBarChart`, `StrategyTable`, `CcloudPanel` | 30s |
| Calibration | `Calibration.tsx` | `CalibrationTable`, `RecalibrateButton` | 30s |
| MTTR & Cost | `MttrCost.tsx` | `MttrMetrics`, `CostCards`, `RoutingPieChart` | 60s |
| Execution Log | `ExecutionLog.tsx` | `LogTable` (virtualised) | 10s |

### Ordre de développement recommandé

```
Semaine 1 (priorité haute — ce que les juges voient en premier)
  Jour 1-2 : Scaffold + API layer + Layout + TopBar + TabBar
  Jour 3   : LiveDiagnostic + AuditFeed SSE
  Jour 4   : Incidents + ApprovalPanel (PENDING_APPROVAL flow)
  Jour 5   : Sidebar complète (trigger, chaos, webhook, predictive)

Semaine 2 (profondeur architecturale)
  Jour 1   : WhyDecision (RAG score, causal chain, handoffs)
  Jour 2   : MemoryWinRates + WinRateBarChart (Recharts)
  Jour 3   : Calibration + MttrCost
  Jour 4   : ExecutionLog + JudgeGuide
  Jour 5   : Polish, responsive, dark mode cohérent

Semaine 3 (qualité production)
  Auth     : écran de login (password → Cognito-ready)
  Tests    : Vitest + Testing Library sur les composants critiques
  Perf     : React.memo, virtualisation du log table
  Build    : vite build + vérification du bundle size

Semaine 4 (buffer + déploiement)
  Docker   : Dockerfile.dashboard (nginx + build statique)
  AWS      : S3 + CloudFront OU ECS Fargate (au choix)
  Demo     : run complet du Judge Guide sur la version React
```

---

## Étape 5 — Composants détaillés

### 5.1 `<IncidentProgress />` — remplace `_live_status_widget`

```tsx
// Refresh toutes les 3s via TanStack Query refetchInterval
// Affiche uniquement les incidents TRIGGERED/DIAGNOSING/REPAIRING
// Progress bar animée CSS : 33% DIAGNOSING, 66% REPAIRING, 100% RESOLVED
// Badge agent actif : 🔍 Diagnostician / 🔧 Remediator / ✅ Auditor
```

### 5.2 `<TurnExpander />` — remplace `render_incident_turns`

```tsx
// Pour chaque turn dans contextJson.turns :
// - Badge agent + numéro de turn
// - Badge source : "🧠 Bedrock" | "🤖 Simulated"
// - Thought (texte collapsible)
// - Tool call : nom + input formaté JSON
// - Tool result : output formaté JSON
// Expand/collapse individuel + "Tout développer"
```

### 5.3 `<AuditFeed />` — remplace `_audit_stream_widget`

```tsx
// Connecté au hook useAuditStream (SSE)
// Liste scrollable des 50 derniers events
// Icône par type d'event : 🔄 status_change, 🔧 tool_call, ✅ resolved
// Badge "🟢 CDC LIVE" / "🔴 CDC OFFLINE" dans la TopBar
// Animation fade-in sur chaque nouvel event
```

### 5.4 `<ApprovalPanel />` — remplace le bloc PENDING_APPROVAL

```tsx
// Banner warning si incidents en attente
// Pour chaque incident PENDING_APPROVAL :
//   - Card avec incidentId, strategy proposée, RAG score, win-rate
//   - Boutons ✅ Approve / ❌ Reject
//   - Expander "🔧 Corriger la stratégie" → select + Apply
// useMutation → invalidate ["incidents"] au succès
```

### 5.5 `<WinRateBarChart />` — remplace `st.bar_chart`

```tsx
// Recharts BarChart horizontal
// X : win-rate en %
// Y : nom de la stratégie
// Couleur : vert si > 80%, jaune si 50-80%, rouge si < 50%
// Tooltip : "N wins / M total incidents"
```

### 5.6 `<SidebarTrigger />` — remplace tout le sidebar Streamlit

```tsx
// Section 🚨 Trigger
//   Select PRESET_SCENARIOS (10 options)
//   Textarea custom alert
//   Select Chaos mode (none / latency / partition / sigkill)
//   Button ⚡ Trigger Agent → POST /incidents/trigger

// Section ☠️ Process Crash
//   Button 💀 SIGKILL → POST /chaos/sigkill

// Section 🌐 CloudWatch Webhook
//   Input AlarmName, NewStateReason
//   Button 📡 Simulate → POST /webhook/cloudwatch

// Section 🔮 Predictive
//   Select PREDICTIVE_SCENARIOS (5 options)
//   Button 📡 Ingest metric → POST /metrics/ingest

// Section 🌱 Vector Memory
//   Button Reset seed → POST /metrics/seed
```

---

## Étape 6 — Auth (production-ready dès le départ)

### Phase 1 — Hackathon (simple, immédiat)

```tsx
// src/components/LoginGate.tsx
// Affiche un écran de login si VITE_DASHBOARD_PASSWORD est défini
// Stocke le token en sessionStorage
// Aucune dépendance externe
```

### Phase 2 — AWS Marketplace (post-hackathon, sans réécriture)

```tsx
// Remplacer LoginGate par AmplifyAuth (AWS Amplify v6 + Cognito)
// Le reste de l'app ne change pas — LoginGate est isolé dans App.tsx
// ALB gère l'auth avant même que React charge (option zero-code)
```

---

## Étape 7 — Variables d'environnement

### Développement (`.env.local` dans `artifacts/dashboard/`)

```env
VITE_API_BASE_URL=http://localhost:8080/api
VITE_API_KEY=dev-key-change-me
VITE_DASHBOARD_PASSWORD=
```

### Production (ECS task env ou S3 + CloudFront via SSM)

```env
VITE_API_BASE_URL=https://cloud-surgeon.xyz/api
VITE_API_KEY=<depuis Secrets Manager>
VITE_DASHBOARD_PASSWORD=hackathon2026
```

> **Note Vite :** les variables `VITE_*` sont inlinées au build.
> En production, builder avec les vraies valeurs ou utiliser une config runtime
> (endpoint `/api/config` qui retourne les valeurs non-sensibles).

---

## Étape 8 — Dockerfile production (S3/CloudFront)

```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/dashboard/ ./artifacts/dashboard/
RUN npm install -g pnpm && pnpm install --frozen-lockfile
ARG VITE_API_BASE_URL
ARG VITE_API_KEY
RUN pnpm --filter @workspace/dashboard run build

FROM nginx:alpine
COPY --from=builder /app/artifacts/dashboard/dist /usr/share/nginx/html
COPY artifacts/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

```nginx
# artifacts/dashboard/nginx.conf
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # SPA fallback — toutes les routes → index.html
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Cache agressif sur les assets hachés
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

Avantage : image finale ~25 MB (nginx + HTML/JS/CSS statiques).
Sur S3 + CloudFront : **zéro Fargate** pour le dashboard → ~$2/mois.

---

## Récapitulatif — Ce qui change, ce qui ne change pas

### Ne change pas
- ✅ Express API Server (100% intact)
- ✅ CockroachDB schema
- ✅ Toutes les routes `/api/*`
- ✅ SSE stream `/api/stream/audit`
- ✅ CDC changefeed
- ✅ Workflow `API Server`
- ✅ Tous les secrets

### Change
- 🔄 `cloud-surgeon-agent/frontend/` → `cloud-surgeon-agent/old/frontend/`
- 🆕 `artifacts/dashboard/` — React app
- 🔄 Workflow `Cloud-Surgeon Dashboard` → pointe vers `artifacts/dashboard`
- 🆕 `.env.local` dans `artifacts/dashboard/`
- 🔄 `DEPLOYMENT.md` — section dashboard mise à jour (nginx + S3)

### Supprimé
- ❌ Streamlit workflow (remplacé)
- ❌ `requirements.txt` à la racine de `cloud-surgeon-agent/`
- ❌ `.streamlit/config.toml` (archivé dans `old/`)
