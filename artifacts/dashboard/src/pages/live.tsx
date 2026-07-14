import { useState, useEffect, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useListIncidents } from "@workspace/api-client-react";
import { Activity, Terminal, AlertTriangle, ShieldCheck, Database } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface SSEEvent {
  type: string;
  incidentId: string;
  status: string;
  timestamp: string;
  agent?: string;
  action?: string;
  result?: string;
  message?: string;
}

export default function LiveDiagnostic() {
  const { data: incidents } = useListIncidents({ query: { refetchInterval: 3000 } });
  
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [sseStatus, setSseStatus] = useState<"LIVE" | "OFFLINE">("OFFLINE");
  const maxEvents = 50;

  useEffect(() => {
    const baseUrl = import.meta.env.VITE_API_BASE_URL || "/api";
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
    <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500 h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-border pb-4 shrink-0">
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 shrink-0">
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

      <div className="flex-1 flex flex-col min-h-0 border border-border bg-[#0a0a0a] rounded-sm overflow-hidden">
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
            events.map((ev, i) => (
              <div key={i} className="text-xs font-mono border-l-2 pl-3 py-1 space-y-1 animate-in fade-in slide-in-from-left-2" style={{
                borderColor: 
                  ev.type === "agent_turn" ? "hsl(var(--primary))" :
                  ev.type === "incident_status" ? "hsl(var(--green-500))" :
                  "hsl(var(--muted-foreground))"
              }}>
                <div className="flex items-center gap-2 opacity-60">
                  <span>[{formatDate(ev.timestamp)}]</span>
                  {ev.incidentId && <span>{ev.incidentId.split("-")[0]}</span>}
                  {ev.type === "incident_status" && <Badge variant="outline" className="text-[10px] py-0 h-4">{ev.status}</Badge>}
                  {ev.agent && <span className="text-primary font-bold">{ev.agent}</span>}
                </div>
                {ev.message && <div className="text-foreground">{ev.message}</div>}
                {ev.action && <div className="text-cyan-400">&gt; {ev.action}</div>}
                {ev.result && <div className="text-muted-foreground ml-2 opacity-80 whitespace-pre-wrap">{ev.result.substring(0, 200)}{ev.result.length > 200 ? "..." : ""}</div>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
