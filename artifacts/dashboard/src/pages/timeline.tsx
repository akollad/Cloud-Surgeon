import { useParams, Link } from "wouter";
import {
  useGetIncident,
  useListExecutionLogs,
  useGetIncidentHandoffs,
  useCountExecutionLogs,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  GitBranch,
  Clock,
  Database,
  AlertTriangle,
  Wrench,
  Zap,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Agent config ────────────────────────────────────────────────────────────

type AgentKey = "diagnostician" | "remediator" | "auditor";

const AGENT: Record<
  AgentKey,
  { label: string; color: string; border: string; bg: string; Icon: React.ElementType }
> = {
  diagnostician: {
    label: "DIAGNOSTICIAN",
    color: "text-blue-400",
    border: "border-blue-500",
    bg: "bg-blue-500/15",
    Icon: Search,
  },
  remediator: {
    label: "REMEDIATOR",
    color: "text-violet-400",
    border: "border-violet-500",
    bg: "bg-violet-500/15",
    Icon: Wrench,
  },
  auditor: {
    label: "AUDITOR",
    color: "text-emerald-400",
    border: "border-emerald-500",
    bg: "bg-emerald-500/15",
    Icon: Zap,
  },
};

function agentCfg(name?: string | null) {
  const key = (name ?? "").toLowerCase() as AgentKey;
  return AGENT[key] ?? {
    label: (name ?? "UNKNOWN").toUpperCase(),
    color: "text-muted-foreground",
    border: "border-border",
    bg: "bg-muted/20",
    Icon: Search,
  };
}

// ── Mode badge ───────────────────────────────────────────────────────────────

function ModeBadge({ mode }: { mode?: string | null }) {
  if (!mode) return null;
  const cls =
    mode === "AUTONOMOUS"       ? "text-green-400 border-green-500/40 bg-green-500/10" :
    mode === "EXPLORATORY"      ? "text-yellow-400 border-yellow-500/40 bg-yellow-500/10" :
    mode === "PENDING_APPROVAL" ? "text-orange-400 border-orange-500/40 bg-orange-500/10" :
    "text-muted-foreground border-border";
  return (
    <span className={cn("text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 border rounded-sm", cls)}>
      {mode.replace(/_/g, " ")}
    </span>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLS: Record<string, string> = {
  FAILED:           "text-red-400 border-red-500/50 bg-red-500/10",
  RESOLVED:         "text-green-400 border-green-500/50 bg-green-500/10",
  TRIGGERED:        "text-red-400 border-red-500/40 bg-red-500/10",
  DIAGNOSING:       "text-yellow-400 border-yellow-500/40 bg-yellow-500/10",
  REPAIRING:        "text-cyan-400 border-cyan-500/40 bg-cyan-500/10",
  PENDING_APPROVAL: "text-orange-400 border-orange-500/40 bg-orange-500/10",
  PREDICTIVE:       "text-purple-400 border-purple-500/40 bg-purple-500/10",
};

// ── Time helpers ─────────────────────────────────────────────────────────────

function toHMS(ts: string | Date | undefined | null): string {
  if (!ts) return "—";
  try {
    const d = typeof ts === "string" ? new Date(ts) : ts;
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

function coerceDate(v: string | Date | undefined | null): Date | null {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  return isNaN(d.getTime()) ? null : d;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function IncidentTimeline() {
  const params = useParams<{ incidentId: string }>();
  const { incidentId } = params;

  const { data: incident, isLoading } = useGetIncident(incidentId, {
    query: { refetchInterval: 5000 },
  });
  const { data: rawHandoffs } = useGetIncidentHandoffs(incidentId, {
    query: { refetchInterval: 5000 },
  });
  const { data: logs } = useListExecutionLogs(
    { incidentId },
    { query: { refetchInterval: 5000 } },
  );
  const { data: logCount } = useCountExecutionLogs(
    { incidentId },
    { query: { refetchInterval: 10000 } },
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-sm text-muted-foreground animate-pulse">
        LOADING INCIDENT…
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="max-w-3xl mx-auto pt-16 text-center space-y-4">
        <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
        <p className="font-mono text-sm text-muted-foreground">Incident not found.</p>
        <Link href="/incidents">
          <Button variant="outline" size="sm" className="font-mono text-xs">
            <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
          </Button>
        </Link>
      </div>
    );
  }

  const ctx = incident.contextJson ?? ({} as Record<string, unknown>);
  const strategyName = (ctx.strategyName as string | undefined) ?? null;

  // Normalise handoffs — server returns `createdAt`, spec has `handoffAt`
  const handoffs = (rawHandoffs ?? []) as Array<{
    agentName?: string | null;
    decisionMode?: string | null;
    note?: string | null;
    summary?: string | null;
    handoffAt?: string | null;
    createdAt?: string | null;
  }>;

  const handoffCount = handoffs.length;
  const actionCount = logCount?.count ?? logs?.length ?? 0;

  // ── Merged timeline ────────────────────────────────────────────────────────
  type TItem =
    | { kind: "handoff"; ts: Date | null; agentName?: string | null; decisionMode?: string | null; note?: string | null }
    | { kind: "log";     ts: Date | null; action: string; result?: string | null };

  const items: TItem[] = [
    ...handoffs.map(h => ({
      kind: "handoff" as const,
      ts: coerceDate(h.createdAt ?? h.handoffAt),
      agentName: h.agentName,
      decisionMode: h.decisionMode,
      note: h.note ?? h.summary,
    })),
    ...(logs ?? []).map(l => ({
      kind: "log" as const,
      ts: coerceDate(l.createdAt),
      action: l.actionTaken,
      result: l.result,
    })),
  ].sort((a, b) => {
    if (!a.ts && !b.ts) return 0;
    if (!a.ts) return 1;
    if (!b.ts) return -1;
    return a.ts.getTime() - b.ts.getTime();
  });

  return (
    <div className="max-w-4xl mx-auto space-y-0 animate-in fade-in duration-300 pb-12">

      {/* ── Back + title ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 pb-5 border-b border-border">
        <Link href="/incidents">
          <Button variant="ghost" size="sm" className="font-mono text-xs text-muted-foreground gap-1 px-2 h-7">
            <ArrowLeft className="w-3 h-3" />
          </Button>
        </Link>
        <h1 className="text-xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-primary" />
          Incident Timeline
        </h1>
      </div>

      {/* ── Incident header card ───────────────────────────────────────────── */}
      <div className="mt-5 border border-border rounded-sm bg-card">
        {/* Top row: label + status badge + stats */}
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Incident</p>
          <div className="flex items-center gap-3 ml-auto">
            <span className={cn("text-xs font-mono px-2 py-0.5 border rounded-sm font-semibold", STATUS_CLS[incident.status] ?? "")}>
              {incident.status}
            </span>
            <span className="text-xs font-mono text-muted-foreground flex items-center gap-1.5 whitespace-nowrap">
              <Clock className="w-3 h-3" />
              {actionCount} action{actionCount !== 1 ? "s" : ""} · {handoffCount} handoff{handoffCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {/* Fingerprint row */}
        <div className="px-4 py-3 border-b border-border font-mono text-sm text-foreground/80 truncate" title={incident.alertFingerprint}>
          [{incident.status}]&nbsp;{incident.alertFingerprint}&nbsp;—
        </div>

        {/* CockroachDB info bar */}
        <div className="px-4 py-2.5 flex items-center gap-2 text-[11px] font-mono text-cyan-400/80 bg-cyan-500/5 border-b border-cyan-500/20 flex-wrap">
          <Database className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
          <span className="text-cyan-500 font-semibold">CockroachDB</span>
          <span className="text-muted-foreground">—</span>
          <span>incident_state <span className="text-muted-foreground/70">(SERIALIZABLE lock)</span></span>
          <span className="text-muted-foreground">·</span>
          <span>execution_logs <span className="text-muted-foreground/70">({actionCount} rows)</span></span>
          <span className="text-muted-foreground">·</span>
          <span>agent_handoffs <span className="text-muted-foreground/70">({handoffCount} rows)</span></span>
          {strategyName && (
            <>
              <span className="text-muted-foreground">·</span>
              <span>strategy <span className="text-foreground/70">"{strategyName}"</span></span>
            </>
          )}
        </div>
      </div>

      {/* ── Timeline ───────────────────────────────────────────────────────── */}
      <div className="mt-6 relative pl-10">
        {/* Vertical line */}
        <div className="absolute left-[15px] top-0 bottom-0 w-px bg-border/60" />

        {/* ── Incident triggered (synthetic first event) ── */}
        <div className="relative mb-4">
          <div className="absolute -left-[25px] top-[3px] w-8 h-8 rounded-full border-2 border-muted-foreground/40 bg-muted/20 flex items-center justify-center z-10">
            <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground/70" />
          </div>
          <div className="ml-2 space-y-1 font-mono">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{toHMS(incident.updatedAt)}</span>
              <span className="uppercase text-foreground/60 font-bold tracking-wider text-[10px]">INCIDENT TRIGGERED</span>
            </div>
            <div className="border border-border/60 bg-card rounded-sm p-3 space-y-1 text-xs">
              <p className="text-foreground/80 truncate" title={incident.alertFingerprint}>
                {incident.alertFingerprint}
              </p>
              <div className="flex items-center gap-3 text-muted-foreground flex-wrap">
                <span>ID: <span className="text-foreground/70">{incident.incidentId.slice(0, 8)}</span></span>
                {strategyName && (
                  <span>Strategy: <span className="text-cyan-400">{strategyName}</span></span>
                )}
                {ctx.winRate != null && (
                  <span>Win-rate: <span className="text-foreground/70">{Math.round(Number(ctx.winRate) * 100)}%</span></span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Timeline items ── */}
        {items.length === 0 ? (
          <div className="ml-2 py-10 text-center font-mono text-xs text-muted-foreground border border-dashed border-border rounded-sm">
            NO EVENTS YET — AGENT MAY STILL BE RUNNING
          </div>
        ) : (
          items.map((item, i) => {
            if (item.kind === "handoff") {
              const cfg = agentCfg(item.agentName);
              const { Icon } = cfg;
              return (
                <div key={i} className="relative mb-3 group">
                  {/* Circle */}
                  <div className={cn(
                    "absolute -left-[25px] top-[2px] w-8 h-8 rounded-full border-2 flex items-center justify-center z-10 transition-transform group-hover:scale-110",
                    cfg.border, cfg.bg,
                  )}>
                    <Icon className={cn("w-3.5 h-3.5", cfg.color)} />
                  </div>

                  <div className="ml-2 space-y-0.5 font-mono">
                    {/* Meta row */}
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="text-muted-foreground text-[10px]">{toHMS(item.ts)}</span>
                      <span className="text-muted-foreground/50">→</span>
                      <span className={cn("font-bold", cfg.color)}>{cfg.label}</span>
                      <ModeBadge mode={item.decisionMode} />
                    </div>
                    {/* Note */}
                    {item.note && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed pl-0">
                        "{item.note}"
                      </p>
                    )}
                  </div>
                </div>
              );
            }

            // Execution log
            return (
              <div key={i} className="relative mb-3">
                <div className="absolute -left-[25px] top-[2px] w-8 h-8 rounded-full border-2 border-primary/40 bg-primary/10 flex items-center justify-center z-10">
                  <span className="text-primary text-[9px] font-bold font-mono">LOG</span>
                </div>
                <div className="ml-2 space-y-0.5 font-mono">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="text-[10px]">{toHMS(item.ts)}</span>
                  </div>
                  <p className="text-xs text-foreground/80 break-all">
                    {item.action}
                  </p>
                  {item.result && (
                    <p className="text-[11px] text-muted-foreground/70 break-all whitespace-pre-wrap pl-2 border-l border-border/50">
                      {item.result.length > 500 ? item.result.slice(0, 500) + "…" : item.result}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* ── Terminal status ── */}
        {(incident.status === "RESOLVED" || incident.status === "FAILED") && (
          <div className="relative mb-3">
            <div className={cn(
              "absolute -left-[25px] top-[2px] w-8 h-8 rounded-full border-2 flex items-center justify-center z-10",
              incident.status === "RESOLVED"
                ? "border-green-500 bg-green-500/15"
                : "border-red-500 bg-red-500/15",
            )}>
              <span className={cn(
                "text-[9px] font-bold font-mono",
                incident.status === "RESOLVED" ? "text-green-400" : "text-red-400",
              )}>
                {incident.status === "RESOLVED" ? "OK" : "ERR"}
              </span>
            </div>
            <div className="ml-2 font-mono text-xs">
              <span className={incident.status === "RESOLVED" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                {incident.status}
              </span>
              {ctx.finalResponse && (
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  {String(ctx.finalResponse).slice(0, 300)}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
