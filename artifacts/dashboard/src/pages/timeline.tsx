import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useListIncidents, customFetch } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, Database, AlertTriangle, Wrench, Zap, Check, X, Terminal, ArrowRight, Clock, Loader, History, ExternalLink, Brain, UserCheck, ShieldCheck, RefreshCw } from "lucide-react";
import { IncidentPickerModal } from "@/components/ui/incident-picker-modal";
import { cn } from "@/lib/utils";

// ── Utils ────────────────────────────────────────────────────────────────────

function fmtTime(ts: string | null | undefined) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return "—"; }
}

function fmtDate(ts: string | null | undefined) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return "—"; }
}

function fmtMttr(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ── Agent helpers (mirrors prod Gie / Fie) ───────────────────────────────────

function agentIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("diag")) return <Database className="w-3.5 h-3.5 text-cyan-400" />;
  if (n.includes("remed")) return <Wrench className="w-3.5 h-3.5 text-purple-400" />;
  if (n.includes("audit")) return <Zap className="w-3.5 h-3.5 text-amber-400" />;
  return <Terminal className="w-3.5 h-3.5 text-muted-foreground" />;
}

function agentClasses(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("diag")) return "text-cyan-400 border-cyan-500/40 bg-cyan-500/10";
  if (n.includes("remed")) return "text-purple-400 border-purple-500/40 bg-purple-500/10";
  if (n.includes("audit")) return "text-amber-400 border-amber-500/40 bg-amber-500/10";
  return "text-muted-foreground border-border bg-muted/20";
}

// ── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLASSES: Record<string, string> = {
  RESOLVED:         "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  FAILED:           "bg-red-500/15 text-red-400 border-red-500/30",
  PENDING_APPROVAL: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  TRIGGERED:        "bg-blue-500/15 text-blue-400 border-blue-500/30",
  DIAGNOSING:       "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  REPAIRING:        "bg-purple-500/15 text-purple-400 border-purple-500/30",
  PREDICTIVE:       "bg-violet-500/15 text-violet-400 border-violet-500/30",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      "inline-flex items-center px-2 py-0.5 rounded-sm border font-mono text-[10px] uppercase tracking-wider",
      STATUS_CLASSES[status] ?? "bg-muted/40 text-muted-foreground border-border/50"
    )}>
      {status}
    </span>
  );
}

// ── Timestamp ─────────────────────────────────────────────────────────────────

function Ts({ ts }: { ts: string | null | undefined }) {
  return (
    <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums shrink-0">
      {fmtTime(ts)}
    </span>
  );
}

// ── Event types ───────────────────────────────────────────────────────────────

type TransitionReason = "human_approved" | "autonomous_reeval" | "feedback_corrected";

type AnyEvent =
  | { kind: "trigger";    ts: string; incident: any }
  | { kind: "handoff";    ts: string; h: any }
  | { kind: "log";        ts: string; l: any }
  | { kind: "transition"; ts: string; reason: TransitionReason; fromMode: string; toMode: string; agentName: string }
  | { kind: "resolve";    ts: string; status: string; mttrMs: number | null; humanWaitMs: number | null; verdict?: string };

function inferTransitionReason(autonomousNote: string): TransitionReason {
  // PENDING_APPROVAL → AUTONOMOUS requires an explicit human /approve call —
  // there is no automatic re-evaluation or timeout in the agent loop.
  // The only exception is a feedback-corrected re-dispatch.
  const n = autonomousNote.toLowerCase();
  if (n.includes("feedback") || n.includes("corrected")) return "feedback_corrected";
  return "human_approved"; // default: human used the Approve button
}

function mergeEvents(incident: any, logs: any[], handoffs: any[]): AnyEvent[] {
  // Sort all handoffs and logs by timestamp.
  const sortedHandoffs = [...handoffs].sort(
    (a, b) => new Date(a.createdAt ?? a.handoffAt).getTime() - new Date(b.createdAt ?? b.handoffAt).getTime()
  );
  const sortedLogs = [...logs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const middle: AnyEvent[] = [];

  // Build handoff events and inject transition cards between PENDING_APPROVAL → AUTONOMOUS.
  for (let i = 0; i < sortedHandoffs.length; i++) {
    const h = sortedHandoffs[i];
    const prev = sortedHandoffs[i - 1];
    const ts = h.createdAt ?? h.handoffAt;

    // Detect mode escalation: previous handoff was PENDING_APPROVAL, current is AUTONOMOUS
    if (
      prev &&
      prev.agentName === h.agentName &&
      prev.decisionMode === "PENDING_APPROVAL" &&
      h.decisionMode === "AUTONOMOUS"
    ) {
      const reason = inferTransitionReason(h.note ?? "");
      middle.push({
        kind: "transition",
        ts,
        reason,
        fromMode: "PENDING_APPROVAL",
        toMode: "AUTONOMOUS",
        agentName: h.agentName,
      });
    }

    middle.push({ kind: "handoff", ts, h });
  }

  for (const l of sortedLogs) {
    middle.push({ kind: "log", ts: l.createdAt, l });
  }

  // Sort all middle events together.
  middle.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  // Use the earliest available timestamp as the trigger time.
  const candidateTs = [
    incident.triggeredAt,
    middle[0]?.ts,
    incident.createdAt,
    incident.updatedAt,
  ].filter(Boolean) as string[];
  const triggerTs = candidateTs.reduce(
    (min, t) => new Date(t).getTime() < new Date(min).getTime() ? t : min,
    candidateTs[0],
  );

  // Trigger always first, resolve always last.
  const r: AnyEvent[] = [];
  r.push({ kind: "trigger", ts: triggerTs, incident });
  r.push(...middle);

  const terminal = ["RESOLVED", "FAILED", "PENDING_APPROVAL"];
  if (incident.resolvedAt || terminal.includes(incident.status)) {
    const ts = incident.resolvedAt ?? incident.updatedAt;

    // agentStartedAt is stored in contextJson when Phase 1 (remediator) begins.
    // For human-approved incidents this is AFTER the operator review window, so
    // we can separate "agent execution time" from "human wait time".
    const agentStartedAt = (incident.contextJson as any)?.agentStartedAt as string | undefined;

    const agentMttrMs = incident.resolvedAt
      ? new Date(incident.resolvedAt).getTime() -
        new Date(agentStartedAt ?? triggerTs).getTime()
      : null;

    // Human wait = time between trigger and when the agent was finally allowed to act.
    // Only meaningful when agentStartedAt was set AND it's clearly a review delay (>5s).
    const humanWaitMs =
      agentStartedAt && incident.resolvedAt
        ? new Date(agentStartedAt).getTime() - new Date(triggerTs).getTime()
        : null;

    // Extract verdict from last verify_resolution log if present.
    const verifyLog = sortedLogs.findLast((l: any) => {
      try { return JSON.parse(l.result ?? "{}").verdict; } catch { return false; }
    });
    let verdict: string | undefined;
    try { verdict = verifyLog ? JSON.parse(verifyLog.result).verdict : undefined; } catch {}
    r.push({ kind: "resolve", ts, status: incident.status, mttrMs: agentMttrMs, humanWaitMs, verdict });
  }

  return r;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TriggerEvent({ ev }: { ev: Extract<AnyEvent, { kind: "trigger" }> }) {
  const ctx = ev.incident.contextJson ?? {};
  // Prefer a human-readable alert description from contextJson; fall back to
  // a labelled truncation of the SHA fingerprint.
  const alertText: string | undefined = ctx.alertText ?? ctx.alert ?? ctx.scenario;
  const fp = ev.incident.alertFingerprint as string;
  const fpShort = fp ? `${fp.slice(0, 12)}…${fp.slice(-8)}` : "";

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center gap-1">
        <div className="w-8 h-8 rounded-full bg-blue-500/15 border border-blue-500/40 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 text-blue-400" />
        </div>
        <div className="w-px flex-1 bg-border/40" />
      </div>
      <div className="pb-4 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Ts ts={ev.ts} />
          <span className="font-mono text-xs font-bold text-blue-400 uppercase tracking-wider">
            Incident Triggered
          </span>
        </div>
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-sm p-3 space-y-2">
          {alertText ? (
            <p className="font-mono text-xs text-foreground/90 break-words">{alertText}</p>
          ) : (
            <p className="font-mono text-xs text-muted-foreground/70 break-words">
              <span className="text-muted-foreground/40 mr-1">fingerprint</span>{fpShort}
            </p>
          )}
          <div className="flex flex-wrap gap-3 text-[10px] font-mono text-muted-foreground">
            <span>ID: <span className="text-foreground/70">{ev.incident.incidentId.slice(0, 8)}</span></span>
            {ctx.strategyName && (
              <span>Strategy: <span className="text-cyan-400">{ctx.strategyName}</span></span>
            )}
            {ctx.winRate != null && (
              <span>Win-rate: <span className="text-emerald-400">{(ctx.winRate * 100).toFixed(0)}%</span></span>
            )}
            {ctx.ragDistance != null && (
              <span>RAG dist: <span className="text-amber-400">{ctx.ragDistance.toFixed(3)}</span></span>
            )}
            {ctx.stormDetected && (
              <span className="text-red-400">⚠ Storm detected</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TransitionEvent({ ev }: { ev: Extract<AnyEvent, { kind: "transition" }> }) {
  const labels: Record<TransitionReason, { text: string; sub: string; color: string }> = {
    human_approved:      { text: "Human approval received",         sub: "Operator reviewed and approved the remediation plan.",            color: "text-violet-400" },
    autonomous_reeval:   { text: "Autonomous re-evaluation",        sub: "Vector memory re-sampled — confidence threshold met. Agent proceeding without human gating.", color: "text-amber-400" },
    feedback_corrected:  { text: "Feedback-corrected re-dispatch",  sub: "Previous strategy corrected by human signal. Agent replanning with updated win-rate.", color: "text-orange-400" },
  };
  const { text, sub, color } = labels[ev.reason];
  const Icon = ev.reason === "human_approved" ? UserCheck : ev.reason === "feedback_corrected" ? RefreshCw : Brain;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center gap-1">
        <div className={cn("w-8 h-8 rounded-sm border flex items-center justify-center shrink-0",
          ev.reason === "human_approved"     ? "bg-violet-500/10 border-violet-500/30" :
          ev.reason === "feedback_corrected" ? "bg-orange-500/10 border-orange-500/30" :
                                               "bg-amber-500/10 border-amber-500/30"
        )}>
          <Icon className={cn("w-3.5 h-3.5", color)} />
        </div>
        <div className="w-px flex-1 bg-border/30" />
      </div>
      <div className="pb-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <Ts ts={ev.ts} />
          <span className={cn("font-mono text-[11px] font-bold uppercase tracking-wider", color)}>{text}</span>
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm border bg-muted/20 text-muted-foreground border-border/50 uppercase">
            {ev.fromMode} → {ev.toMode}
          </span>
        </div>
        <p className="font-mono text-[10px] text-muted-foreground/70 italic pl-0.5">{sub}</p>
      </div>
    </div>
  );
}

function HandoffEvent({ ev }: { ev: Extract<AnyEvent, { kind: "handoff" }> }) {
  const h = ev.h;
  const cls = agentClasses(h.agentName ?? "");
  const colorClass = cls.split(" ")[0]; // first class is the text color
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center gap-1">
        <div className={cn("w-8 h-8 rounded-full border flex items-center justify-center shrink-0", cls)}>
          {agentIcon(h.agentName ?? "")}
        </div>
        <div className="w-px flex-1 bg-border/40" />
      </div>
      <div className="pb-4 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <Ts ts={ev.ts} />
          <ArrowRight className="w-3 h-3 text-muted-foreground/50 shrink-0" />
          <span className={cn("font-mono text-xs font-bold uppercase tracking-wider", colorClass)}>
            {h.agentName}
          </span>
          {h.decisionMode && (
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm border bg-muted/20 text-muted-foreground border-border/50 uppercase">
              {h.decisionMode}
            </span>
          )}
        </div>
        {h.note && (
          <p className="font-mono text-xs text-muted-foreground/80 italic pl-0.5 break-words">
            "{h.note}"
          </p>
        )}
      </div>
    </div>
  );
}

// Parse the result JSON once and surface meaningful verdicts as inline banners.
function parseLogVerdict(raw: string | null | undefined): { verdict?: string; message?: string } {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function LogEvent({ ev }: { ev: Extract<AnyEvent, { kind: "log" }> }) {
  const [expanded, setExpanded] = useState(false);
  const l = ev.l;
  const hasResult = l.result && l.result.trim().length > 0;
  const preview = l.result?.slice(0, 200) ?? "";
  const truncated = (l.result?.length ?? 0) > 200;

  const { verdict, message } = parseLogVerdict(l.result);
  const isNoAction    = verdict === "NO_ACTION_REQUIRED";
  const isRepaired    = verdict === "REPAIRED" || verdict === "VERIFIED";
  const isFeedback    = (l.actionTaken as string ?? "").toLowerCase().includes("feedback");

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center gap-1">
        <div className={cn(
          "w-8 h-8 rounded-sm border flex items-center justify-center shrink-0",
          isNoAction || isRepaired ? "bg-emerald-500/10 border-emerald-500/30" :
          isFeedback               ? "bg-violet-500/10 border-violet-500/30" :
                                     "bg-muted/20 border-border/50"
        )}>
          {isNoAction || isRepaired
            ? <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            : isFeedback
            ? <UserCheck className="w-3.5 h-3.5 text-violet-400" />
            : <Terminal className="w-3.5 h-3.5 text-muted-foreground/70" />}
        </div>
        <div className="w-px flex-1 bg-border/30" />
      </div>
      <div className="pb-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <Ts ts={ev.ts} />
          <span className="font-mono text-[11px] text-foreground/80 break-words">{l.actionTaken}</span>
        </div>

        {/* Verdict banner — shown before the raw JSON block */}
        {isNoAction && (
          <div className="mb-1.5 flex items-center gap-2 px-3 py-1.5 rounded-sm bg-emerald-500/10 border border-emerald-500/25">
            <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
            <span className="font-mono text-[10px] text-emerald-300">
              Service self-healed — no infrastructure change required. Verification complete.
            </span>
          </div>
        )}
        {isRepaired && (
          <div className="mb-1.5 flex items-center gap-2 px-3 py-1.5 rounded-sm bg-emerald-500/10 border border-emerald-500/25">
            <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
            <span className="font-mono text-[10px] text-emerald-300">
              {message ?? "Repair verified — incident closed and indexed in vector memory."}
            </span>
          </div>
        )}
        {isFeedback && (
          <div className="mb-1.5 flex items-center gap-2 px-3 py-1.5 rounded-sm bg-violet-500/10 border border-violet-500/25">
            <UserCheck className="w-3 h-3 text-violet-400 shrink-0" />
            <span className="font-mono text-[10px] text-violet-300">
              Human feedback recorded — win-rate updated in vector memory for future incidents.
            </span>
          </div>
        )}

        {hasResult && (
          <div
            className="bg-muted/10 border border-border/30 rounded-sm px-3 py-2 cursor-pointer hover:bg-muted/20 transition-colors"
            onClick={() => setExpanded(x => !x)}
          >
            <pre className="font-mono text-[10px] text-muted-foreground/70 whitespace-pre-wrap break-words leading-relaxed">
              {expanded ? l.result : preview}{truncated && !expanded ? "…" : ""}
            </pre>
            {truncated && (
              <span className="text-[9px] font-mono text-primary/60 mt-1 block">
                {expanded ? "▲ collapse" : "▼ expand"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResolveEvent({ ev }: { ev: Extract<AnyEvent, { kind: "resolve" }> }) {
  const ok = ev.status === "RESOLVED";
  const pending = ev.status === "PENDING_APPROVAL";

  // Human-readable narrative for common verdict codes.
  const narratives: Record<string, string> = {
    NO_ACTION_REQUIRED: "Service recovered autonomously — agent verified health and closed incident without infrastructure changes.",
    REPAIRED:           "Infrastructure repair applied and confirmed healthy. Incident closed.",
    VERIFIED:           "Post-repair verification passed. System nominal.",
  };
  const narrative = ev.verdict ? narratives[ev.verdict] : undefined;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={cn(
          "w-8 h-8 rounded-full border flex items-center justify-center shrink-0",
          ok      ? "bg-emerald-500/15 border-emerald-500/40" :
          pending ? "bg-amber-500/15 border-amber-500/40" :
                    "bg-red-500/15 border-red-500/40"
        )}>
          {ok      ? <Check className="w-3.5 h-3.5 text-emerald-400" /> :
           pending ? <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> :
                     <X className="w-3.5 h-3.5 text-red-400" />}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <Ts ts={ev.ts} />
          <StatusBadge status={ev.status} />
          {ev.mttrMs != null && (
            <span className="font-mono text-[10px] text-muted-foreground">
              MTTR: <span className="text-emerald-400 font-bold">{fmtMttr(ev.mttrMs)}</span>
              {ev.humanWaitMs != null && ev.humanWaitMs > 5000 && (
                <span className="text-amber-400/70 ml-1">
                  (+ {fmtMttr(ev.humanWaitMs)} human review)
                </span>
              )}
            </span>
          )}
        </div>
        {narrative && (
          <p className="font-mono text-[10px] text-muted-foreground/70 italic pl-0.5 mt-0.5">{narrative}</p>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IncidentTimeline() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const urlIncidentId = new URLSearchParams(search).get("incidentId");

  const { data: incidents = [], isLoading: loadingList } = useListIncidents();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeId = selectedId ?? urlIncidentId ?? incidents[0]?.incidentId ?? null;

  function selectIncident(id: string) {
    setSelectedId(id);
    navigate(`/timeline?incidentId=${id}`);
  }

  const { data: incident, isLoading: loadingIncident } = useQuery({
    queryKey: ["incident", activeId],
    queryFn: () => customFetch<any>(`/api/incidents/${activeId}`),
    enabled: !!activeId,
  });

  const { data: logs = [], isLoading: loadingLogs } = useQuery({
    queryKey: ["logs", activeId],
    queryFn: () => customFetch<any[]>(`/api/logs?incidentId=${activeId}`),
    enabled: !!activeId,
  });

  const { data: handoffs = [], isLoading: loadingHandoffs } = useQuery({
    queryKey: ["handoffs", activeId],
    queryFn: () => customFetch<any[]>(`/api/handoffs?incidentId=${activeId}`),
    enabled: !!activeId,
  });

  const isLoading = loadingList || loadingIncident || loadingLogs || loadingHandoffs;
  const events = incident ? mergeEvents(incident, logs as any[], handoffs as any[]) : [];

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-500 pb-10">

      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-border pb-4 gap-3 flex-wrap">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center gap-2 shrink-0">
          <History className="h-5 w-5 text-primary" />
          Incident Timeline
        </h1>
        <div className="flex items-center gap-2">
          {isLoading && <Loader className="w-4 h-4 text-muted-foreground/50 animate-spin" />}
          <button
            onClick={() => navigate(`/incidents`)}
            className="flex items-center gap-1.5 h-8 px-3 border border-border rounded-sm bg-background text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
          >
            ← All Incidents
          </button>
          {activeId && (
            <button
              onClick={() => navigate(`/decision?incidentId=${activeId}`)}
              className="flex items-center gap-1.5 h-8 px-3 border border-border rounded-sm bg-background text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
            >
              Decision Trace
              <ExternalLink className="w-3 h-3 opacity-50" />
            </button>
          )}
        </div>
      </div>

      {/* ── Incident picker ── */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        {/* Picker trigger */}
        <div className="relative flex-1 min-w-0">
          <button
            onClick={() => setPickerOpen(o => !o)}
            className="flex items-center gap-2 w-full h-9 px-3 border border-border rounded-sm bg-background text-left hover:border-primary/50 transition-colors group"
          >
            <GitBranch className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="flex-1 font-mono text-xs text-muted-foreground truncate">
              {incident
                ? `${incident.status} · ${incident.alertFingerprint.slice(0, 50)}${incident.alertFingerprint.length > 50 ? "…" : ""}`
                : loadingList ? "Loading…" : "Select incident…"}
            </span>
            <X className={cn("w-3.5 h-3.5 text-muted-foreground shrink-0 transition-opacity", pickerOpen ? "opacity-100" : "opacity-0 pointer-events-none")} />
          </button>

          <IncidentPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            incidents={incidents as any[]}
            selectedId={activeId}
            onSelect={selectIncident}
            loading={loadingList}
          />
        </div>

        {/* Meta */}
        {incident && (
          <div className="flex items-center gap-3 flex-wrap shrink-0">
            <span className="font-mono text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {fmtDate(incident.triggeredAt ?? incident.createdAt)}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {(logs as any[]).length} actions · {(handoffs as any[]).length} handoffs
            </span>
          </div>
        )}
      </div>

      {/* ── CockroachDB info bar ── */}
      {incident && (
        <div className="flex gap-2 flex-wrap text-[10px] font-mono text-muted-foreground bg-muted/10 border border-border/40 rounded-sm px-3 py-2">
          <Database className="w-3 h-3 text-cyan-400 shrink-0 mt-px" />
          <span>
            <span className="text-cyan-400">CockroachDB</span>
            {" — "}
            incident_state (SERIALIZABLE lock) · execution_logs ({(logs as any[]).length} rows) · agent_handoffs ({(handoffs as any[]).length} rows) ·
            {incident.contextJson?.strategyName
              ? ` strategy "${incident.contextJson.strategyName}"`
              : " strategy memory via VECTOR(1024) RAG"}
          </span>
        </div>
      )}

      {/* ── Empty states ── */}
      {!activeId && !loadingList && (
        <p className="font-mono text-sm text-muted-foreground text-center py-16">
          No incidents yet — trigger one from the Controls panel.
        </p>
      )}
      {activeId && isLoading && !incident && (
        <div className="flex justify-center py-16">
          <Loader className="w-6 h-6 text-muted-foreground/40 animate-spin" />
        </div>
      )}

      {/* ── Timeline ── */}
      {events.length > 0 && (
        <div className="space-y-0 pt-2">
          {events.map((ev, i) =>
            ev.kind === "trigger"    ? <TriggerEvent    key={i} ev={ev} /> :
            ev.kind === "transition" ? <TransitionEvent key={i} ev={ev} /> :
            ev.kind === "handoff"    ? <HandoffEvent    key={i} ev={ev} /> :
            ev.kind === "log"        ? <LogEvent        key={i} ev={ev} /> :
            ev.kind === "resolve"    ? <ResolveEvent    key={i} ev={ev} /> :
            null
          )}
        </div>
      )}
    </div>
  );
}
