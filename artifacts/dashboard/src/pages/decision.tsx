import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { useListIncidents, useGetIncident, useGetIncidentCausalChain, useGetIncidentHandoffs } from "@workspace/api-client-react";
import { GitCommit, Search, ShieldAlert, Cpu, ArrowRight } from "lucide-react";
import { formatDate } from "@/lib/utils";

export default function DecisionTrace() {
  const { data: incidents } = useListIncidents({ query: { refetchInterval: 5000 } });
  const [selectedId, setSelectedId] = useState<string>("");

  const actualSelectedId = selectedId || (incidents?.[0]?.incidentId ?? "");

  const { data: incident } = useGetIncident(actualSelectedId, { query: { enabled: !!actualSelectedId } });
  const { data: chain } = useGetIncidentCausalChain(actualSelectedId, { query: { enabled: !!actualSelectedId } });
  const { data: handoffs } = useGetIncidentHandoffs(actualSelectedId, { query: { enabled: !!actualSelectedId } });

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <GitCommit className="mr-2 h-5 w-5 text-primary" />
          Decision Trace
        </h1>
        <div className="w-96">
          <Select value={actualSelectedId} onChange={(e) => setSelectedId(e.target.value)}>
            <option value="" disabled>Select an incident...</option>
            {incidents?.map(i => (
              <option key={i.incidentId} value={i.incidentId}>
                {formatDate(i.updatedAt)} - {i.alertFingerprint}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!incident ? (
        <div className="p-12 text-center text-muted-foreground font-mono text-sm border border-dashed">
          NO INCIDENT SELECTED
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          <div className="lg:col-span-1 space-y-6">
            <Card>
              <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-foreground">Routing Logic</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4 font-mono text-sm">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground uppercase">Routing Mode</div>
                  <Badge variant={incident.contextJson?.routingMode?.toLowerCase() as any || "outline"}>
                    {incident.contextJson?.routingMode || "UNKNOWN"}
                  </Badge>
                </div>
                
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground uppercase">Strategy Matched</div>
                  <div className="text-cyan-400 break-all">{incident.contextJson?.strategyName || "NONE"}</div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground uppercase">RAG Score</div>
                    <div className="text-lg text-foreground">{(incident.contextJson?.ragScore ?? 0).toFixed(4)}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground uppercase">Win Rate</div>
                    <div className="text-lg text-foreground">
                      {incident.contextJson?.winRate != null ? `${(incident.contextJson.winRate * 100).toFixed(1)}%` : "N/A"}
                    </div>
                  </div>
                </div>
                
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground uppercase">Sample Size</div>
                  <div className="text-foreground">{incident.contextJson?.winRateSampleSize ?? 0} executions</div>
                </div>

                {incident.contextJson?.crashed && (
                  <Badge variant="destructive" className="w-full justify-center py-1 mt-2">
                    CRASH RECOVERED
                  </Badge>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-foreground flex items-center"><Search className="w-4 h-4 mr-2"/> Alert Context</CardTitle>
              </CardHeader>
              <CardContent className="p-4 font-mono text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                {incident.contextJson?.alertText || "No alert text"}
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2 space-y-6">
            
            <Card>
              <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-foreground flex items-center"><Cpu className="w-4 h-4 mr-2"/> Agent Handoffs</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {handoffs && handoffs.length > 0 ? (
                  <div className="space-y-3">
                    {handoffs.map((h, i) => (
                      <div key={i} className="border border-border rounded-sm overflow-hidden">
                        {/* Header */}
                        <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border flex-wrap">
                          <span className="px-2 py-0.5 text-[11px] font-mono font-bold uppercase tracking-wide text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 rounded-sm">
                            {h.agentName || "AGENT"}
                          </span>
                          {h.decisionMode && (
                            <>
                              <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                              <span className="px-2 py-0.5 text-[11px] font-mono font-bold uppercase tracking-wide text-primary bg-primary/10 border border-primary/30 rounded-sm">
                                {h.decisionMode}
                              </span>
                            </>
                          )}
                          <span className="ml-auto text-[11px] font-mono text-muted-foreground/70 shrink-0">
                            {formatDate(h.createdAt)}
                          </span>
                        </div>
                        {/* Note */}
                        <div className="px-4 py-3 text-sm font-mono text-white/90 leading-relaxed bg-background/60">
                          {h.note
                            ? h.note
                            : <span className="text-muted-foreground italic text-xs">No note recorded</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground text-sm font-mono opacity-50">No handoffs recorded.</div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-foreground flex items-center"><ShieldAlert className="w-4 h-4 mr-2"/> Causal Chain Analysis</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {chain?.chain && chain.chain.length > 0 ? (
                  <div className="relative pl-4 space-y-6 before:absolute before:inset-y-0 before:left-[7px] before:w-[2px] before:bg-border">
                    {chain.chain.map((c: any, i: number) => (
                      <div key={i} className="relative">
                        <div className="absolute -left-6 top-1.5 w-3 h-3 rounded-full bg-primary ring-4 ring-background" />
                        <div className="border border-border p-4 bg-background shadow-sm font-mono text-sm space-y-2">
                          <div className="text-xs text-muted-foreground">{c.status}</div>
                          <div className="text-foreground">{c.fingerprint}</div>
                          {c.strategy && <div className="text-cyan-400 text-xs">Strategy: {c.strategy}</div>}
                          {c.depth && <div className="absolute top-4 right-4 text-xs text-muted-foreground bg-muted px-2 py-0.5">Depth {c.depth}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground text-sm font-mono opacity-50">Causal chain not computed or unavailable.</div>
                )}
              </CardContent>
            </Card>

          </div>
        </div>
      )}
    </div>
  );
}
