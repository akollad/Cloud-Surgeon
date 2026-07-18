import { useParams, Link } from "wouter";
import { useGetIncident, useListExecutionLogs, useGetIncidentHandoffs, useGetCalibration } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatDate } from "@/lib/utils";
import { ArrowLeft, GitCommit, Terminal, Cpu, SlidersHorizontal, Clock, AlertTriangle } from "lucide-react";

const STATUS_COLOR: Record<string, string> = {
  TRIGGERED:        "text-red-400 border-red-500/40 bg-red-500/10",
  DIAGNOSING:       "text-yellow-400 border-yellow-500/40 bg-yellow-500/10",
  REPAIRING:        "text-cyan-400 border-cyan-500/40 bg-cyan-500/10",
  PENDING_APPROVAL: "text-orange-400 border-orange-500/40 bg-orange-500/10",
  PREDICTIVE:       "text-purple-400 border-purple-500/40 bg-purple-500/10",
  RESOLVED:         "text-green-400 border-green-500/40 bg-green-500/10",
  FAILED:           "text-red-500 border-red-600/40 bg-red-600/10",
};

const ROUTING_DESC: Record<string, string> = {
  AUTONOMOUS:       "Agent ran autonomously — high confidence, no human gate.",
  PENDING_APPROVAL: "Operator approval required — confidence below threshold.",
  EXPLORATORY:      "Low sample size — exploring a new strategy.",
  REJECTED:         "Operator rejected the proposed action.",
};

export default function IncidentTimeline() {
  const params = useParams<{ incidentId: string }>();
  const incidentId = params.incidentId;

  const { data: incident, isLoading: incLoading } = useGetIncident(incidentId, {
    query: { refetchInterval: 4000 },
  });
  const { data: logs } = useListExecutionLogs(
    { incidentId },
    { query: { refetchInterval: 4000 } },
  );
  const { data: handoffs } = useGetIncidentHandoffs(incidentId, {
    query: { refetchInterval: 4000 },
  });
  const { data: calibration } = useGetCalibration();

  if (incLoading) {
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
            <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to All Incidents
          </Button>
        </Link>
      </div>
    );
  }

  const ctx = incident.contextJson ?? {};
  const plan = ctx.repairPlan;
  const stratName = ctx.strategyName ?? "—";
  const calEntry = calibration?.find(c => c.strategyName === stratName);

  // Build merged timeline: handoffs first (phase gates), then logs (actions)
  type TimelineItem =
    | { kind: "handoff"; ts: string; agentName: string; decisionMode?: string; note?: string }
    | { kind: "log";     ts: string; action: string; result?: string | null };

  const timeline: TimelineItem[] = [
    ...(handoffs ?? []).map(h => ({
      kind: "handoff" as const,
      ts: typeof h.handoffAt === "string" ? h.handoffAt : new Date(h.handoffAt as any).toISOString(),
      agentName: h.agentName ?? "unknown",
      decisionMode: (h as any).decisionMode,
      note: h.summary,
    })),
    ...(logs ?? []).map(l => ({
      kind: "log" as const,
      ts: typeof l.createdAt === "string" ? l.createdAt : new Date(l.createdAt as any).toISOString(),
      action: l.actionTaken,
      result: l.result,
    })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-400 pb-12">

      {/* ── Back link ── */}
      <div className="flex items-center gap-3 pt-1">
        <Link href="/incidents">
          <Button variant="ghost" size="sm" className="font-mono text-xs text-muted-foreground gap-1.5 px-2">
            <ArrowLeft className="w-3.5 h-3.5" /> All Incidents
          </Button>
        </Link>
      </div>

      {/* ── Header ── */}
      <div className="border-b border-border pb-4 space-y-2">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1 min-w-0">
            <h1 className="font-mono text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
              <GitCommit className="h-4 w-4 text-primary shrink-0" />
              Incident Timeline
            </h1>
            <p className="font-mono text-xs text-muted-foreground truncate" title={incident.incidentId}>
              {incident.incidentId}
            </p>
          </div>
          <Badge className={cn("font-mono text-xs border shrink-0", STATUS_COLOR[incident.status] ?? "")}>
            {incident.status}
          </Badge>
        </div>
        <p className="font-mono text-sm text-foreground/80 break-all">{incident.alertFingerprint}</p>
      </div>

      {/* ── Decision summary ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Routing Mode",      value: ctx.routingMode ?? "—" },
          { label: "Strategy",          value: stratName },
          { label: "Win Rate",          value: ctx.winRate != null ? `${(ctx.winRate * 100).toFixed(1)}%` : "—" },
          { label: "Effective Win Rate",value: ctx.effectiveWinRate != null ? `${(ctx.effectiveWinRate * 100).toFixed(1)}%` : "—" },
        ].map(({ label, value }) => (
          <div key={label} className="border border-border rounded-sm p-3 bg-card space-y-1">
            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</p>
            <p className="font-mono text-sm text-foreground truncate" title={value}>{value}</p>
          </div>
        ))}
      </div>

      {/* Routing description */}
      {ctx.routingMode && ROUTING_DESC[ctx.routingMode] && (
        <p className="text-xs font-mono text-muted-foreground border-l-2 border-primary/40 pl-3 py-1">
          {ROUTING_DESC[ctx.routingMode]}
        </p>
      )}

      {/* ── Repair plan summary (if any) ── */}
      {plan && (
        <div className="border border-border rounded-sm p-4 bg-card space-y-3">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-muted-foreground">
            <Cpu className="h-3.5 w-3.5 text-primary" />
            Repair Plan
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs font-mono">
            {plan.strategy && (
              <div><span className="text-muted-foreground">Strategy: </span><span className="text-foreground">{plan.strategy}</span></div>
            )}
            {plan.riskLevel && (
              <div><span className="text-muted-foreground">Risk: </span>
                <span className={cn(plan.riskLevel === "high" ? "text-red-400" : plan.riskLevel === "medium" ? "text-yellow-400" : "text-green-400")}>
                  {plan.riskLevel.toUpperCase()}
                </span>
              </div>
            )}
            {plan.estimatedDuration && (
              <div><span className="text-muted-foreground">Est. duration: </span><span className="text-foreground">{plan.estimatedDuration}</span></div>
            )}
          </div>
          {plan.steps && plan.steps.length > 0 && (
            <ol className="space-y-1 pl-4 list-decimal text-xs font-mono text-foreground/80">
              {plan.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          )}
        </div>
      )}

      {/* ── Calibration match ── */}
      {calEntry && (
        <div className="border border-border rounded-sm p-4 bg-card">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">
            <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
            Bandit Calibration — {stratName}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
            {[
              { label: "Predicted",   value: calEntry.predictedWinRate != null ? `${(calEntry.predictedWinRate * 100).toFixed(1)}%` : "—" },
              { label: "Observed",    value: calEntry.observedWinRate != null ? `${(calEntry.observedWinRate * 100).toFixed(1)}%` : "—" },
              { label: "Correction",  value: calEntry.correctionFactor != null ? calEntry.correctionFactor.toFixed(3) : "—" },
              { label: "Sample size", value: calEntry.sampleSize != null ? String(calEntry.sampleSize) : "—" },
            ].map(({ label, value }) => (
              <div key={label} className="space-y-1">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
                <p className="text-foreground">{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Merged timeline ── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-muted-foreground">
          <Clock className="h-3.5 w-3.5 text-primary" />
          Event Timeline ({timeline.length} events)
        </div>

        {timeline.length === 0 ? (
          <div className="border border-dashed border-border rounded-sm p-8 text-center font-mono text-xs text-muted-foreground">
            NO EVENTS YET — AGENT MAY STILL BE RUNNING
          </div>
        ) : (
          <div className="relative pl-4 space-y-0">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />

            {timeline.map((item, i) => (
              <div key={i} className="relative flex gap-4 pb-4 last:pb-0">
                {/* Dot */}
                <div className={cn(
                  "absolute left-0 top-[5px] w-3.5 h-3.5 rounded-full border-2 shrink-0 z-10",
                  item.kind === "handoff"
                    ? "border-cyan-400 bg-cyan-400/20"
                    : "border-primary bg-primary/20"
                )} />

                {/* Content */}
                <div className="ml-6 flex-1 min-w-0 space-y-1 font-mono text-xs">
                  <div className="flex items-center gap-2 flex-wrap text-muted-foreground">
                    <span className="text-[10px]">[{formatDate(item.ts)}]</span>
                    {item.kind === "handoff" ? (
                      <>
                        <span className="text-cyan-400 font-bold uppercase">{item.agentName}</span>
                        {item.decisionMode && (
                          <span className="text-[10px] px-1.5 py-0.5 border border-primary/30 bg-primary/5 text-primary">
                            {item.decisionMode}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-primary/70 uppercase text-[10px] tracking-wider">action</span>
                    )}
                  </div>

                  {item.kind === "handoff" && item.note && (
                    <p className="text-foreground/80">{item.note}</p>
                  )}

                  {item.kind === "log" && (
                    <>
                      <p className="text-foreground">&gt; {item.action}</p>
                      {item.result && (
                        <p className="text-muted-foreground ml-3 whitespace-pre-wrap break-all">
                          {item.result.length > 400 ? item.result.slice(0, 400) + "…" : item.result}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Final response ── */}
      {ctx.finalResponse && (
        <div className="border border-border rounded-sm p-4 bg-card space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Final Agent Response</p>
          <p className="font-mono text-xs text-foreground/90 whitespace-pre-wrap">{ctx.finalResponse}</p>
        </div>
      )}

    </div>
  );
}
