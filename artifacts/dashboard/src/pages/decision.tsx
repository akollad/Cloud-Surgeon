import { useState, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  useListIncidents, useGetIncident, useGetIncidentCausalChain,
  useGetIncidentHandoffs, useGetIncidentPlaybook, useGetIncidentRollbackPlan,
} from "@workspace/api-client-react";
import type { Incident } from "@workspace/api-client-react";
import {
  GitCommit, Search, Cpu, ArrowRight, Zap, RotateCcw, BookOpen,
  AlertTriangle, CheckCircle, Clock, ShieldCheck, GitBranch, Layers,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

// ── Local type mirrors (server types reflected in contextJson) ─────────────

interface RepairPlan {
  strategy: string;
  estimatedDuration: string;
  riskLevel: "low" | "medium" | "high";
  blastRadius: string;
  steps: string[];
  preconditions: string[];
  expectedOutcome: string;
  alternatives: string[];
  generatedBy: "llm" | "deterministic";
  generatedAt: string;
}

interface RollbackInfo {
  steps: string[];
  estimatedTime: string;
  riskLevel: "low" | "medium" | "high";
  commandsExecuted: string[];
  warnings: string[];
  generatedAt: string;
}

// ── Feature 4: Confidence Score Card ─────────────────────────────────────

function ConfidenceCard({ incident }: { incident: Incident }) {
  const ctx = incident.contextJson as Record<string, unknown>;
  const effectiveWinRate = (ctx?.effectiveWinRate ?? ctx?.winRate ?? 0) as number;
  const score = Math.round(effectiveWinRate * 100);
  const sampleSize = (ctx?.winRateSampleSize ?? 0) as number;
  const correctionFactor = (ctx?.correctionFactor ?? null) as number | null;
  const repairPlan = ctx?.repairPlan as RepairPlan | undefined;
  const strategyName = (ctx?.strategyName ?? "unknown") as string;

  const scoreColor =
    score >= 80 ? "#22d3ee" : score >= 60 ? "#facc15" : score >= 40 ? "#fb923c" : "#f87171";
  const circumference = 2 * Math.PI * 44;
  const dash = (score / 100) * circumference;

  const riskLabel = repairPlan?.riskLevel ?? "unknown";
  const riskColor =
    riskLabel === "low" ? "text-green-400" : riskLabel === "medium" ? "text-yellow-400" : "text-red-400";

  return (
    <Card>
      <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
        <CardTitle className="text-foreground flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" /> Repair Confidence
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {/* Circular score gauge */}
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <svg width="96" height="96" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="44" fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
              <circle
                cx="48" cy="48" r="44" fill="none"
                stroke={scoreColor} strokeWidth="8"
                strokeDasharray={`${dash} ${circumference}`}
                strokeLinecap="round"
                transform="rotate(-90 48 48)"
                style={{ transition: "stroke-dasharray 0.6s ease" }}
              />
              <text x="48" y="44" textAnchor="middle" fontSize="20" fontWeight="bold" fill="white" fontFamily="monospace">{score}</text>
              <text x="48" y="60" textAnchor="middle" fontSize="10" fill="hsl(var(--muted-foreground))" fontFamily="monospace">/ 100</text>
            </svg>
          </div>
          <div className="font-mono text-sm space-y-1.5 flex-1">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
              <span className="text-muted-foreground text-xs">Similar incidents:</span>
              <span className="text-foreground font-bold text-xs">{sampleSize}</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
              <span className="text-muted-foreground text-xs">Success rate:</span>
              <span className="text-foreground font-bold text-xs">{score}%</span>
            </div>
            <div className="flex items-center gap-2">
              <AlertTriangle className={`w-3 h-3 shrink-0 ${riskColor}`} />
              <span className="text-muted-foreground text-xs">Blast radius:</span>
              <span className={`font-bold text-xs capitalize ${riskColor}`}>{riskLabel}</span>
            </div>
            {correctionFactor != null && Math.abs(correctionFactor - 1) > 0.01 && (
              <div className="flex items-center gap-2">
                <Layers className="w-3 h-3 text-cyan-400 shrink-0" />
                <span className="text-muted-foreground text-xs">Calibrated:</span>
                <span className="text-cyan-400 font-bold text-xs">×{correctionFactor.toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Routing mode badge */}
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground uppercase font-mono">Routing Decision</div>
          <Badge variant={(ctx?.routingMode as string)?.toLowerCase() as any || "outline"} className="text-xs">
            {(ctx?.routingMode as string) || "UNKNOWN"}
          </Badge>
        </div>

        {/* Strategy */}
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground uppercase font-mono">Strategy</div>
          <div className="text-cyan-400 font-mono text-xs break-all">{strategyName}</div>
        </div>

        {/* Reason summary */}
        {sampleSize > 0 && (
          <div className="bg-muted/30 border border-border/50 rounded-sm px-3 py-2 text-xs font-mono text-muted-foreground leading-relaxed">
            Based on <span className="text-foreground font-bold">{sampleSize}</span> historical execution{sampleSize > 1 ? "s" : ""} with{" "}
            <span className="text-foreground font-bold">{score}%</span> weighted success rate
            {correctionFactor != null && Math.abs(correctionFactor - 1) > 0.01
              ? ` (calibrated ×${correctionFactor.toFixed(2)})`
              : ""}
            .
          </div>
        )}

        {!!ctx?.crashed && (
          <Badge variant="destructive" className="w-full justify-center py-1 text-xs">CRASH RECOVERED</Badge>
        )}
      </CardContent>
    </Card>
  );
}

// ── Feature 5: Causality Graph ────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  RESOLVED: "#22d3ee", FAILED: "#f87171", DIAGNOSING: "#a78bfa",
  REPAIRING: "#fb923c", PENDING_APPROVAL: "#facc15",
  TRIGGERED: "#94a3b8", PREDICTIVE: "#34d399",
};

function CausalityGraph({ chain }: { chain: Array<Record<string, unknown>> }) {
  // Chain is ordered depth DESC — oldest ancestor first, current incident last
  const nodeH = 72;
  const nodeW = 320;
  const gap = 48;
  const svgH = chain.length * nodeH + (chain.length - 1) * gap + 24;

  return (
    <div className="overflow-x-auto">
      <svg
        width={nodeW + 40}
        height={svgH}
        viewBox={`0 0 ${nodeW + 40} ${svgH}`}
        className="font-mono text-xs"
      >
        {chain.map((node, i) => {
          const y = i * (nodeH + gap) + 12;
          const centerX = (nodeW + 40) / 2;
          const status = (node.status as string) ?? "UNKNOWN";
          const color = STATUS_COLORS[status] ?? "#94a3b8";
          const isLast = i === chain.length - 1; // current incident

          return (
            <g key={node.incidentId as string}>
              {/* Connector arrow to next node */}
              {i < chain.length - 1 && (
                <>
                  <line
                    x1={centerX} y1={y + nodeH}
                    x2={centerX} y2={y + nodeH + gap}
                    stroke="hsl(var(--border))" strokeWidth="2" strokeDasharray="4 3"
                  />
                  {/* Arrow head */}
                  <polygon
                    points={`${centerX},${y + nodeH + gap} ${centerX - 5},${y + nodeH + gap - 8} ${centerX + 5},${y + nodeH + gap - 8}`}
                    fill="hsl(var(--border))"
                  />
                </>
              )}

              {/* Node box */}
              <rect
                x="20" y={y} width={nodeW} height={nodeH} rx="4"
                fill="hsl(var(--card))"
                stroke={isLast ? color : "hsl(var(--border))"}
                strokeWidth={isLast ? 2 : 1}
              />
              {/* Left color bar */}
              <rect x="20" y={y} width="4" height={nodeH} rx="2" fill={color} />

              {/* Depth badge */}
              <text x="38" y={y + 16} fontSize="9" fill="hsl(var(--muted-foreground))">
                {isLast ? "CURRENT" : `ANCESTOR · depth ${node.depth}`}
              </text>

              {/* Status */}
              <text x="38" y={y + 32} fontSize="11" fontWeight="bold" fill={color}>
                {status}
              </text>

              {/* Alert fingerprint */}
              <text x="38" y={y + 48} fontSize="10" fill="hsl(var(--foreground))" className="truncate">
                {((node.alertFingerprint as string) ?? (node.incidentId as string) ?? "").slice(0, 42)}
              </text>

              {/* Timestamp */}
              <text x="38" y={y + 64} fontSize="9" fill="hsl(var(--muted-foreground))">
                {node.updatedAt ? new Date(node.updatedAt as string).toLocaleString() : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Simple markdown renderer ───────────────────────────────────────────────

function MarkdownBlock({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="font-mono text-sm space-y-1 leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith("# ")) {
          return <h1 key={i} className="text-base font-bold text-foreground mt-4 mb-1 first:mt-0">{line.slice(2)}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={i} className="text-sm font-bold text-cyan-400 mt-3 mb-1">{line.slice(3)}</h2>;
        }
        if (line.startsWith("### ")) {
          return <h3 key={i} className="text-xs font-bold text-primary mt-2 mb-0.5 uppercase tracking-wide">{line.slice(4)}</h3>;
        }
        if (line.trim() === "") {
          return <div key={i} className="h-1" />;
        }
        // Inline bold + code
        const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
        return (
          <p key={i} className="text-muted-foreground">
            {parts.map((part, j) => {
              if (part.startsWith("**") && part.endsWith("**")) {
                return <strong key={j} className="text-foreground">{part.slice(2, -2)}</strong>;
              }
              if (part.startsWith("`") && part.endsWith("`")) {
                return <code key={j} className="bg-muted/60 px-1 py-0.5 rounded text-xs text-green-400">{part.slice(1, -1)}</code>;
              }
              return part;
            })}
          </p>
        );
      })}
    </div>
  );
}

// ── Risk badge helper ─────────────────────────────────────────────────────

function RiskBadge({ level }: { level: string }) {
  const map: Record<string, string> = {
    low: "text-green-400 bg-green-400/10 border-green-400/30",
    medium: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",
    high: "text-red-400 bg-red-400/10 border-red-400/30",
  };
  return (
    <span className={`px-2 py-0.5 text-[11px] font-mono font-bold uppercase rounded-sm border ${map[level] ?? map.medium}`}>
      {level} risk
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

type RollbackExecState = "idle" | "confirming" | "executing" | "done" | "error";

export default function DecisionTrace() {
  const { data: incidents } = useListIncidents({ query: { refetchInterval: 5000 } });
  const [selectedId, setSelectedId] = useState<string>("");
  const [activeTab, setActiveTab] = useState("execution");

  // Rollback execution state
  const [rollbackState, setRollbackState] = useState<RollbackExecState>("idle");
  const [rollbackExecResult, setRollbackExecResult] = useState<Record<string, unknown> | null>(null);

  const actualSelectedId = selectedId || (incidents?.[0]?.incidentId ?? "");

  const { data: incident, refetch: refetchIncident } = useGetIncident(actualSelectedId, { query: { enabled: !!actualSelectedId } });
  const { data: chain } = useGetIncidentCausalChain(actualSelectedId, { query: { enabled: !!actualSelectedId } });
  const { data: handoffs } = useGetIncidentHandoffs(actualSelectedId, { query: { enabled: !!actualSelectedId } });
  const { data: playbook } = useGetIncidentPlaybook(actualSelectedId, { query: { enabled: !!actualSelectedId } });
  const { data: rollbackPlan, refetch: refetchRollbackPlan } = useGetIncidentRollbackPlan(actualSelectedId, { query: { enabled: !!actualSelectedId } });

  const ctx = incident?.contextJson as Record<string, unknown> | undefined;
  const repairPlan = ctx?.repairPlan as RepairPlan | undefined;
  const rollbackInfo = ctx?.rollbackInfo as RollbackInfo | undefined;

  const executeRollback = useCallback(async () => {
    if (!actualSelectedId) return;
    setRollbackState("executing");
    setRollbackExecResult(null);
    try {
      const apiKey = import.meta.env.VITE_API_KEY ?? "";
      const res = await fetch(`/api/incidents/${actualSelectedId}/rollback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
      });
      const data = await res.json() as Record<string, unknown>;
      setRollbackExecResult(data);
      setRollbackState(data.success ? "done" : "error");
      // Refresh the incident and rollback plan to reflect ROLLED_BACK status
      void refetchIncident();
      void refetchRollbackPlan();
    } catch (err) {
      setRollbackExecResult({ error: err instanceof Error ? err.message : String(err) });
      setRollbackState("error");
    }
  }, [actualSelectedId, refetchIncident, refetchRollbackPlan]);

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4 flex-wrap gap-3">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <GitCommit className="mr-2 h-5 w-5 text-primary" />
          Decision Trace
        </h1>
        <div className="w-96">
          <Select value={actualSelectedId} onChange={(e) => { setSelectedId(e.target.value); setActiveTab("execution"); }}>
            <option value="" disabled>Select an incident...</option>
            {incidents?.map(i => (
              <option key={i.incidentId} value={i.incidentId}>
                {formatDate(i.updatedAt)} — {i.alertFingerprint.slice(0, 40)}
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

          {/* ── Left column ── */}
          <div className="lg:col-span-1 space-y-6">
            {/* Feature 4: Confidence Score Card */}
            <ConfidenceCard incident={incident} />

            {/* Alert Context */}
            <Card>
              <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-foreground flex items-center gap-2">
                  <Search className="w-4 h-4" /> Alert Context
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 font-mono text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                {ctx?.alertText as string || "No alert text"}
              </CardContent>
            </Card>

            {/* Incident metadata */}
            <Card>
              <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-foreground flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Timeline
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 font-mono text-xs space-y-2">
                <div className="flex justify-between text-muted-foreground">
                  <span>Status</span>
                  <Badge variant={incident.status?.toLowerCase() as any} className="text-[10px]">
                    {incident.status}
                  </Badge>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Updated</span>
                  <span className="text-foreground">{formatDate(incident.updatedAt)}</span>
                </div>
                {incident.causedByIncidentId && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Caused by</span>
                    <span className="text-yellow-400 truncate max-w-[120px]">{incident.causedByIncidentId.slice(0, 8)}…</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Right column with tabs ── */}
          <div className="lg:col-span-2">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full">
                <TabsTrigger value="execution"><Cpu className="w-3.5 h-3.5 mr-1.5" />Execution</TabsTrigger>
                <TabsTrigger value="plan"><Zap className="w-3.5 h-3.5 mr-1.5" />Repair Plan</TabsTrigger>
                <TabsTrigger value="graph"><GitBranch className="w-3.5 h-3.5 mr-1.5" />Causal Graph</TabsTrigger>
                <TabsTrigger value="playbook"><BookOpen className="w-3.5 h-3.5 mr-1.5" />Playbook</TabsTrigger>
                <TabsTrigger value="rollback"><RotateCcw className="w-3.5 h-3.5 mr-1.5" />Rollback</TabsTrigger>
              </TabsList>

              {/* ── Tab 1: Execution Trace ── */}
              <TabsContent value="execution">
                <Card>
                  <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <Cpu className="w-4 h-4" /> Agent Handoffs
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    {handoffs && handoffs.length > 0 ? (
                      <div className="space-y-3">
                        {handoffs.map((h, i) => (
                          <div key={i} className="border border-border rounded-sm overflow-hidden">
                            <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border flex-wrap">
                              <span className="px-2 py-0.5 text-[11px] font-mono font-bold uppercase tracking-wide text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 rounded-sm">
                                {String(h.agentName ?? "AGENT")}
                              </span>
                              {!!h.decisionMode && (
                                <>
                                  <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                                  <span className="px-2 py-0.5 text-[11px] font-mono font-bold uppercase tracking-wide text-primary bg-primary/10 border border-primary/30 rounded-sm">
                                    {String(h.decisionMode)}
                                  </span>
                                </>
                              )}
                              <span className="ml-auto text-[11px] font-mono text-muted-foreground/70 shrink-0">
                                {formatDate(String(h.createdAt ?? ""))}
                              </span>
                            </div>
                            <div className="px-4 py-3 text-sm font-mono text-white/90 leading-relaxed bg-background/60">
                              {h.note ? String(h.note) : <span className="text-muted-foreground italic text-xs">No note recorded</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-muted-foreground text-sm font-mono opacity-50">No handoffs recorded.</div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ── Tab 2: Feature 2 — Repair Plan ── */}
              <TabsContent value="plan">
                <Card>
                  <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <Zap className="w-4 h-4 text-yellow-400" />
                      Pre-Execution Simulation Plan
                      {repairPlan && (
                        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                          by {repairPlan.generatedBy}
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    {repairPlan ? (
                      <div className="space-y-5 font-mono text-sm">
                        {/* Meta row */}
                        <div className="flex flex-wrap gap-3 items-center">
                          <RiskBadge level={repairPlan.riskLevel} />
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Clock className="w-3 h-3" /> Est. duration:
                            <span className="text-foreground font-bold">{repairPlan.estimatedDuration}</span>
                          </div>
                        </div>

                        {/* Blast radius */}
                        <div className="bg-yellow-400/5 border border-yellow-400/20 rounded-sm p-3 space-y-1">
                          <div className="text-[10px] uppercase tracking-wide text-yellow-400/80 font-bold">Blast Radius</div>
                          <div className="text-xs text-white/90">{repairPlan.blastRadius}</div>
                        </div>

                        {/* Steps */}
                        <div className="space-y-2">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Execution Steps</div>
                          <ol className="space-y-2">
                            {repairPlan.steps.map((step, i) => (
                              <li key={i} className="flex gap-3 text-xs">
                                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/20 text-primary font-bold text-[10px] flex items-center justify-center">{i + 1}</span>
                                <span className="text-muted-foreground leading-relaxed">{step}</span>
                              </li>
                            ))}
                          </ol>
                        </div>

                        {/* Preconditions */}
                        {repairPlan.preconditions.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Preconditions</div>
                            <ul className="space-y-1">
                              {repairPlan.preconditions.map((p, i) => (
                                <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                                  <CheckCircle className="w-3 h-3 text-green-400 shrink-0 mt-0.5" />{p}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Expected outcome */}
                        <div className="bg-green-400/5 border border-green-400/20 rounded-sm p-3 space-y-1">
                          <div className="text-[10px] uppercase tracking-wide text-green-400/80 font-bold">Expected Outcome</div>
                          <div className="text-xs text-white/90">{repairPlan.expectedOutcome}</div>
                        </div>

                        {/* Alternatives */}
                        {repairPlan.alternatives.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Alternatives Considered & Rejected</div>
                            <div className="flex flex-wrap gap-1.5">
                              {repairPlan.alternatives.map((alt, i) => (
                                <span key={i} className="px-2 py-0.5 text-[10px] bg-muted/40 border border-border rounded-sm text-muted-foreground line-through decoration-muted-foreground/50">
                                  {alt}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-muted-foreground text-sm font-mono opacity-50 py-8 text-center">
                        No repair plan — incident has not reached the Remediator phase yet.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ── Tab 3: Feature 5 — Causality Graph ── */}
              <TabsContent value="graph">
                <Card>
                  <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <GitBranch className="w-4 h-4 text-primary" /> Causal Chain Graph
                      <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                        via recursive CTE (CockroachDB)
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    {chain?.note && (
                      <p className="text-xs font-mono text-muted-foreground border-l-2 border-primary/40 pl-3 mb-4">
                        {chain.note}
                      </p>
                    )}
                    {chain?.chain && chain.chain.length > 0 ? (
                      <CausalityGraph chain={chain.chain as Array<Record<string, unknown>>} />
                    ) : (
                      <div className="text-muted-foreground text-sm font-mono opacity-50 py-8 text-center">
                        No causal chain — this incident has no known ancestor or descendant.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ── Tab 4: Feature 1 — Playbook ── */}
              <TabsContent value="playbook">
                <Card>
                  <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-primary" />
                      AI-Generated Repair Playbook
                      {playbook && (
                        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                          by {playbook.generatedBy} · {playbook.strategyName}
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    {playbook ? (
                      <div className="space-y-4">
                        <div className="text-sm font-mono font-bold text-foreground border-b border-border/50 pb-2">
                          {playbook.title}
                        </div>
                        <div className="bg-muted/10 border border-border/30 rounded-sm p-4 max-h-[520px] overflow-y-auto">
                          <MarkdownBlock content={playbook.contentMd ?? ""} />
                        </div>
                      </div>
                    ) : incident.status === "RESOLVED" ? (
                      <div className="text-muted-foreground text-sm font-mono opacity-50 py-8 text-center">
                        Playbook not found for this incident.
                      </div>
                    ) : (
                      <div className="text-muted-foreground text-sm font-mono opacity-50 py-8 text-center">
                        Playbook is generated after the incident is resolved.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ── Tab 5: Feature 3 — Rollback Plan ── */}
              <TabsContent value="rollback">
                <Card>
                  <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                    <CardTitle className="text-foreground flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <RotateCcw className="w-4 h-4 text-orange-400" /> Rollback Policy
                      </span>
                      {/* Execute Rollback button — only shown when a plan exists and incident hasn't been rolled back yet */}
                      {(rollbackPlan || rollbackInfo) && incident?.status !== "ROLLED_BACK" && (
                        <div className="flex items-center gap-2">
                          {rollbackState === "idle" && (
                            <button
                              onClick={() => setRollbackState("confirming")}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold rounded border border-orange-400/40 text-orange-400 bg-orange-400/5 hover:bg-orange-400/15 transition-colors"
                            >
                              <RotateCcw className="w-3 h-3" /> Execute Rollback
                            </button>
                          )}
                          {rollbackState === "confirming" && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-yellow-400 font-mono">Confirm rollback?</span>
                              <button
                                onClick={() => void executeRollback()}
                                className="px-2 py-1 text-xs font-mono font-bold rounded border border-red-500/50 text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors"
                              >Yes, rollback</button>
                              <button
                                onClick={() => setRollbackState("idle")}
                                className="px-2 py-1 text-xs font-mono rounded border border-border text-muted-foreground hover:bg-muted/30 transition-colors"
                              >Cancel</button>
                            </div>
                          )}
                          {rollbackState === "executing" && (
                            <span className="flex items-center gap-1.5 text-xs font-mono text-orange-400 animate-pulse">
                              <RotateCcw className="w-3 h-3 animate-spin" /> Executing rollback…
                            </span>
                          )}
                          {rollbackState === "done" && (
                            <span className="flex items-center gap-1.5 text-xs font-mono text-green-400">
                              <CheckCircle className="w-3 h-3" /> Rolled back
                            </span>
                          )}
                          {rollbackState === "error" && (
                            <span className="flex items-center gap-1.5 text-xs font-mono text-red-400">
                              <AlertTriangle className="w-3 h-3" /> Rollback failed — see result below
                            </span>
                          )}
                        </div>
                      )}
                      {incident?.status === "ROLLED_BACK" && (
                        <span className="flex items-center gap-1.5 text-xs font-mono text-green-400">
                          <CheckCircle className="w-3 h-3" /> Already rolled back
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    {/* Rollback execution result */}
                    {rollbackExecResult && (
                      <div className={`mb-4 p-3 rounded border text-xs font-mono ${rollbackState === "done" ? "border-green-500/30 bg-green-500/5 text-green-300" : "border-red-500/30 bg-red-500/5 text-red-300"}`}>
                        <div className="font-bold mb-1">{rollbackState === "done" ? "✓ Rollback succeeded" : "✗ Rollback encountered an error"}</div>
                        <div className="text-muted-foreground">{String(rollbackExecResult.message ?? rollbackExecResult.error ?? "")}</div>
                        {rollbackExecResult.result && (
                          <pre className="mt-2 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                            {JSON.stringify(rollbackExecResult.result, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}
                    {/* Prefer DB rollback plan, fallback to context_json.rollbackInfo */}
                    {rollbackPlan ? (
                      <div className="space-y-5 font-mono text-sm">
                        {/* Meta */}
                        <div className="flex flex-wrap gap-3 items-center">
                          <RiskBadge level={rollbackPlan.riskLevel ?? "medium"} />
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Clock className="w-3 h-3" /> Est. rollback time:
                            <span className="text-foreground font-bold">{rollbackPlan.estimatedRollbackTime ?? "unknown"}</span>
                          </div>
                        </div>

                        {/* Commands executed */}
                        {rollbackPlan.executedCommands && (
                          <div className="space-y-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Commands Executed by Agent</div>
                            <pre className="bg-muted/30 border border-border/50 rounded-sm p-3 text-xs text-green-400 overflow-x-auto whitespace-pre-wrap">
                              {rollbackPlan.executedCommands}
                            </pre>
                          </div>
                        )}

                        {/* Pre-repair state */}
                        {rollbackPlan.preRepairState && Object.keys(rollbackPlan.preRepairState as object).length > 0 && (
                          <div className="space-y-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Pre-Repair State Snapshot</div>
                            <pre className="bg-muted/30 border border-border/50 rounded-sm p-3 text-xs text-muted-foreground overflow-x-auto">
                              {JSON.stringify(rollbackPlan.preRepairState, null, 2)}
                            </pre>
                          </div>
                        )}

                        {/* Rollback steps */}
                        {rollbackPlan.rollbackSteps && (
                          <div className="space-y-2">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Rollback Instructions</div>
                            <ol className="space-y-2">
                              {rollbackPlan.rollbackSteps.split("\n").map((step, i) => (
                                <li key={i} className="flex gap-3 text-xs">
                                  <span className="shrink-0 w-5 h-5 rounded-full bg-orange-400/20 text-orange-400 font-bold text-[10px] flex items-center justify-center">{i + 1}</span>
                                  <code className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{step}</code>
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}
                      </div>
                    ) : rollbackInfo ? (
                      /* Fallback: rollbackInfo from context_json (available before DB is written) */
                      <div className="space-y-5 font-mono text-sm">
                        <div className="flex flex-wrap gap-3 items-center">
                          <RiskBadge level={rollbackInfo.riskLevel} />
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Clock className="w-3 h-3" /> Est. rollback time:
                            <span className="text-foreground font-bold">{rollbackInfo.estimatedTime}</span>
                          </div>
                        </div>
                        {rollbackInfo.warnings?.length > 0 && (
                          <div className="space-y-1">
                            {rollbackInfo.warnings.map((w, i) => (
                              <div key={i} className="flex gap-2 text-xs text-yellow-400 bg-yellow-400/5 border border-yellow-400/20 rounded-sm px-3 py-2">
                                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />{w}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="space-y-2">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">Rollback Steps</div>
                          <ol className="space-y-2">
                            {rollbackInfo.steps.map((step, i) => (
                              <li key={i} className="flex gap-3 text-xs">
                                <span className="shrink-0 w-5 h-5 rounded-full bg-orange-400/20 text-orange-400 font-bold text-[10px] flex items-center justify-center">{i + 1}</span>
                                <span className="text-muted-foreground leading-relaxed">{step}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    ) : (
                      <div className="text-muted-foreground text-sm font-mono opacity-50 py-8 text-center">
                        Rollback plan is generated when the agent reaches the Remediator phase.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

            </Tabs>
          </div>
        </div>
      )}
    </div>
  );
}
