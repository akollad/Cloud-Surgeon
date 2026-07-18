import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useListIncidents } from "@workspace/api-client-react";
import { Activity, Terminal, AlertTriangle, ShieldCheck, Database } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";

interface SSEEvent {
  type: "connected" | "heartbeat" | "execution_log" | "agent_handoff" | "incident_status" | string;
  incidentId?: string;
  // connected
  cdcActive?: boolean;
  streamMode?: string;
  message?: string;
  // execution_log
  actionTaken?: string;
  result?: string;
  // agent_handoff
  agentName?: string;
  decisionMode?: string;
  note?: string;
  // incident_status
  status?: string;
  alertFingerprint?: string;
  // all
  createdAt: string;
  source?: string;
}

export default function LiveDiagnostic() {
  const { data: incidents } = useListIncidents({ query: { refetchInterval: 3000 } });
  
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [sseStatus, setSseStatus] = useState<"LIVE" | "OFFLINE">("OFFLINE");
  const maxEvents = 50;

  useEffect(() => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
    // Pass the session JWT as ?token= — EventSource cannot set custom headers.
    const jwt = sessionStorage.getItem('cs-dashboard-token') ?? '';
    const url = `${base}/api/stream/audit${jwt ? `?token=${encodeURIComponent(jwt)}` : ''}`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => setSseStatus("LIVE");
    eventSource.onerror = () => setSseStatus("OFFLINE");

    eventSource.onmessage = (e) => {
      try {
        const data: SSEEvent = JSON.parse(e.data);
        setEvents((prev) => {
          const newEvents = [data, ...prev];
          if (newEvents.length > maxEvents) return newEvents.slice(0, maxEvents);
          return newEvents;
        });
      } catch (err) {
        console.error("Failed to parse SSE event", err);
      }
    };

    return () => eventSource.close();
  }, []);

  const activeIncidents = incidents?.filter(i => 
    ["TRIGGERED", "DIAGNOSING", "REPAIRING", "PENDING_APPROVAL", "PREDICTIVE"].includes(i.status)
  ) || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500 pb-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <Activity className="mr-2 h-5 w-5 text-primary" />
          Live Diagnostic
        </h1>
        <div className="flex items-center gap-4">
          <Badge variant="outline" className={sseStatus === "LIVE" ? "text-green-500 border-green-500/30 bg-green-500/10" : "text-red-500 border-red-500/30"}>
            STREAM: {sseStatus}
          </Badge>
        </div>
      </div>

      {activeIncidents.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {activeIncidents.map((inc, idx) => {
            const statusStyle: Record<string, string> = {
              TRIGGERED:       "border-red-500/60 shadow-[0_0_24px_rgba(239,68,68,0.25)]",
              DIAGNOSING:      "border-yellow-500/60 shadow-[0_0_20px_rgba(234,179,8,0.2)]",
              REPAIRING:       "border-cyan-500/60 shadow-[0_0_20px_rgba(34,211,238,0.2)]",
              PENDING_APPROVAL:"border-orange-500/60 shadow-[0_0_22px_rgba(249,115,22,0.28)]",
              PREDICTIVE:      "border-purple-500/60 shadow-[0_0_20px_rgba(168,85,247,0.2)]",
            };
            const pulseStatus = ["TRIGGERED", "PENDING_APPROVAL"];
            const scanStatus  = ["DIAGNOSING"];
            const repairStatus = ["REPAIRING"];

            return (
              <div
                key={inc.incidentId}
                className={cn(
                  "animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-sm border bg-card overflow-hidden",
                  statusStyle[inc.status] ?? "border-border",
                  pulseStatus.includes(inc.status) && "animate-pulse"
                )}
                style={{ animationDelay: `${idx * 60}ms`, animationFillMode: "both" }}
              >
                {/* Phase progress bar */}
                <div className="h-0.5 w-full overflow-hidden">
                  <div className={cn(
                    "h-full",
                    inc.status === "TRIGGERED"        && "w-1/5 bg-red-500",
                    inc.status === "DIAGNOSING"       && "w-2/5 bg-yellow-500 animate-[scan_2s_ease-in-out_infinite]",
                    inc.status === "REPAIRING"        && "w-3/5 bg-cyan-400 animate-[scan_1.5s_ease-in-out_infinite]",
                    inc.status === "PENDING_APPROVAL" && "w-4/5 bg-orange-400",
                    inc.status === "PREDICTIVE"       && "w-1/3 bg-purple-400 animate-pulse",
                  )} />
                </div>

                <div className="py-3 px-4 flex flex-row items-center justify-between border-b border-border/50">
                  <span className="text-xs text-muted-foreground font-mono truncate" title={inc.incidentId}>
                    {inc.incidentId.split("-")[0]}
                  </span>
                  <Badge variant={inc.status.toLowerCase() as any}>{inc.status}</Badge>
                </div>
                <div className="p-4 space-y-3 min-w-0">
                  {/* Fingerprint — truncated with full value on hover */}
                  <p className="font-mono text-xs leading-tight text-foreground/70 truncate min-w-0"
                     title={inc.alertFingerprint}>
                    {inc.alertFingerprint}
                  </p>
                  {/* Routing mode + strategy — each truncates independently */}
                  <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground min-w-0">
                    <span className="shrink-0 border border-border/50 px-1 rounded-sm text-[10px] uppercase tracking-wide">
                      {inc.contextJson?.routingMode || "PENDING"}
                    </span>
                    <span className="truncate min-w-0 text-cyan-400/80">
                      {inc.contextJson?.strategyName || "NO_STRATEGY"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="shrink-0 p-6 border border-dashed border-border flex items-center justify-center text-muted-foreground font-mono text-sm bg-card/30">
          NO ACTIVE INCIDENTS — SYSTEM NOMINAL
        </div>
      )}

      <div className="min-h-[320px] flex flex-col border border-border bg-card rounded-sm overflow-hidden">
        <div className="bg-muted/50 px-4 py-2 border-b border-border flex items-center space-x-2 text-xs font-mono text-muted-foreground uppercase tracking-wider shrink-0">
          <Terminal className="h-4 w-4" />
          <span>CDC Audit Stream (Latest {maxEvents})</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {events.length === 0 ? (
            <div className="text-center text-muted-foreground font-mono text-xs mt-10 opacity-50">
              WAITING FOR EVENTS...
            </div>
          ) : (
            events.map((ev, i) => {
              const borderColor =
                ev.type === "execution_log"   ? "hsl(var(--primary))" :
                ev.type === "agent_handoff"   ? "#22d3ee" :
                ev.type === "incident_status" ? "#facc15" :
                ev.type === "connected"       ? "#4ade80" :
                ev.type === "heartbeat"       ? "hsl(var(--muted-foreground))" :
                "hsl(var(--muted-foreground))";

              /* heartbeat — ligne pulse discrète */
              if (ev.type === "heartbeat") {
                return (
                  <div key={i} className="flex items-center gap-2 py-0.5 opacity-30 animate-in fade-in duration-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {formatDate(ev.createdAt)} — heartbeat
                    </span>
                  </div>
                );
              }

              return (
                <div key={i} className="text-xs font-mono border-l-2 pl-3 py-1.5 space-y-1 animate-in fade-in slide-in-from-left-2" style={{ borderColor }}>
                  {/* Meta row */}
                  <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
                    <span>[{formatDate(ev.createdAt)}]</span>
                    {ev.incidentId && (
                      <span className="text-primary/70">{ev.incidentId.split("-")[0]}</span>
                    )}
                    <span className="uppercase tracking-wider text-[10px] font-bold" style={{ color: borderColor }}>
                      {ev.type.replace(/_/g, " ")}
                    </span>
                    {ev.source && (
                      <span className="text-muted-foreground/50 text-[10px]">[{ev.source}]</span>
                    )}
                  </div>

                  {/* connected */}
                  {ev.type === "connected" && ev.message && (
                    <div className="text-green-400">{ev.message}</div>
                  )}
                  {ev.type === "connected" && ev.streamMode && (
                    <div className="text-muted-foreground text-[10px]">mode: {ev.streamMode}</div>
                  )}

                  {/* execution_log */}
                  {ev.type === "execution_log" && ev.actionTaken && (
                    <div className="text-foreground">&gt; {ev.actionTaken}</div>
                  )}
                  {ev.type === "execution_log" && ev.result && (
                    <div className="text-muted-foreground ml-2 whitespace-pre-wrap break-all">
                      {ev.result.length > 300 ? ev.result.substring(0, 300) + "…" : ev.result}
                    </div>
                  )}

                  {/* agent_handoff */}
                  {ev.type === "agent_handoff" && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {ev.agentName && (
                        <span className="text-cyan-300 font-bold">{ev.agentName}</span>
                      )}
                      {ev.decisionMode && (
                        <span className="text-primary text-[10px] px-1.5 py-0.5 border border-primary/30 bg-primary/5">
                          {ev.decisionMode}
                        </span>
                      )}
                    </div>
                  )}
                  {ev.type === "agent_handoff" && ev.note && (
                    <div className="text-foreground">{ev.note}</div>
                  )}

                  {/* incident_status */}
                  {ev.type === "incident_status" && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={ev.status?.toLowerCase() as any || "outline"}>
                        {ev.status}
                      </Badge>
                      {ev.alertFingerprint && (
                        <span className="text-foreground/80 truncate max-w-[400px]" title={ev.alertFingerprint}>
                          {ev.alertFingerprint}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
