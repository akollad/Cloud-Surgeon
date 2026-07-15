import { useState, useEffect, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useListIncidents } from "@workspace/api-client-react";
import { Activity, Terminal, AlertTriangle, ShieldCheck, Database } from "lucide-react";
import { formatDate } from "@/lib/utils";

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
    const baseUrl = "/api";
    const apiKey = import.meta.env.VITE_API_KEY ?? "";
    const eventSource = new EventSource(`${baseUrl}/stream/audit?apiKey=${apiKey}`);

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
          {activeIncidents.map(inc => (
            <Card key={inc.incidentId} className="border-primary/50 shadow-[0_0_15px_rgba(0,255,255,0.1)]">
              <CardHeader className="py-3 px-4 flex flex-row items-center justify-between space-y-0 border-b border-border/50">
                <CardTitle className="text-xs text-muted-foreground truncate" title={inc.incidentId}>
                  {inc.incidentId.split("-")[0]}
                </CardTitle>
                <Badge variant={inc.status.toLowerCase() as any}>{inc.status}</Badge>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                <p className="font-mono text-sm leading-tight text-foreground truncate">{inc.alertFingerprint}</p>
                <div className="flex justify-between items-center text-xs font-mono text-muted-foreground">
                  <span>{inc.contextJson?.routingMode || "ROUTING_PENDING"}</span>
                  <span>{inc.contextJson?.strategyName || "NO_STRATEGY"}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="shrink-0 p-6 border border-dashed border-border flex items-center justify-center text-muted-foreground font-mono text-sm bg-card/30">
          NO ACTIVE INCIDENTS — SYSTEM NOMINAL
        </div>
      )}

      <div className="min-h-[320px] flex flex-col border border-border bg-[#0a0a0a] rounded-sm overflow-hidden">
        <div className="bg-muted px-4 py-2 border-b border-border flex items-center space-x-2 text-xs font-mono text-muted-foreground uppercase tracking-wider shrink-0">
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
                    <div className="text-white/90">&gt; {ev.actionTaken}</div>
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
                    <div className="text-white/90">{ev.note}</div>
                  )}

                  {/* incident_status */}
                  {ev.type === "incident_status" && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={ev.status?.toLowerCase() as any || "outline"}>
                        {ev.status}
                      </Badge>
                      {ev.alertFingerprint && (
                        <span className="text-white/80 truncate max-w-[400px]" title={ev.alertFingerprint}>
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
