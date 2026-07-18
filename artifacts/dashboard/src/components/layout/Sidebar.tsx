import { useState } from "react";
import {
  useTriggerIncident, useSigkillProcess, useSimulateCloudwatchWebhook,
  useIngestMetrics, useSeedVectorMemory,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { PanelSelect } from "@/components/ui/panel-select";
import { Server, Activity, AlertTriangle, Zap, Terminal, X,
         ChevronLeft, ChevronRight, CheckCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const PRESET_SCENARIOS = [
  "ECS service checkout: payment 5xx spike",
  "Primary DB CPU saturation (RDS)",
  "Cascading Lambda throttling",
  "Worker node disk full",
  "JVM memory leak (recommendation service)",
  "DB connection pool exhausted (Postgres RDS)",
  "Cross-region latency > SLA (API Gateway)",
  "Expired AWS credential (S3 access from ECS)",
  "External dependency down (Stripe API)",
  "Unknown incident (exploratory scenario)",
  "CockroachDB hot range detected — write contention on table incidents causing 3x latency spike",
  "CockroachDB index advisor: full table scan on incident_vectors — missing index costs 2.4s per query",
  "CockroachDB slow query detected — SELECT running 45s blocking connection pool",
  "CockroachDB under-replicated ranges in us-east-1 — possible node failure, RF=1 detected",
  "CDC changefeed 'incidents-to-webhook' paused — last event 15 minutes ago, lag accumulating",
];

const PREDICTIVE_SCENARIOS = [
  "ECS CPU spike (pre-alarm)",
  "RDS connections approaching limit",
  "Lambda throttling pre-alarm",
  "High ALB response time",
  "Disk usage critical",
];

const CHAOS_OPTIONS = [
  { value: "none",      label: "None" },
  { value: "latency",   label: "Network latency (+500ms)" },
  { value: "partition", label: "DB partition (2 timeouts)" },
  { value: "sigkill",   label: "SIGKILL crash after diagnostic" },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

// ── Styled input ──────────────────────────────────────────────────────────────
function SidebarInput({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full h-9 px-3 rounded-sm border font-mono text-xs",
        "bg-[hsl(214,50%,10%)] border-[hsl(214,45%,26%)] text-[hsl(210,35%,88%)]",
        "placeholder:text-[hsl(210,20%,40%)]",
        "focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30",
        "hover:border-[hsl(214,45%,34%)] transition-colors",
      )}
    />
  );
}

// ── Styled textarea ───────────────────────────────────────────────────────────
function SidebarTextarea({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      className={cn(
        "w-full px-3 py-2 rounded-sm border font-mono text-xs resize-none",
        "bg-[hsl(214,50%,10%)] border-[hsl(214,45%,26%)] text-[hsl(210,35%,88%)]",
        "placeholder:text-[hsl(210,20%,40%)]",
        "focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30",
        "hover:border-[hsl(214,45%,34%)] transition-colors",
      )}
    />
  );
}

// ── Section label ─────────────────────────────────────────────────────────────
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[10px] uppercase font-mono tracking-wider text-[hsl(210,20%,60%)] mb-1">
      {children}
    </label>
  );
}

// ── Section header ────────────────────────────────────────────────────────────
function SectionHeader({
  icon, label, color,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 mb-3", color)}>
      {icon}
      <h2 className="font-mono text-[11px] uppercase font-bold tracking-wider">{label}</h2>
    </div>
  );
}

// ── Main sidebar ──────────────────────────────────────────────────────────────
export function Sidebar({ open, onClose, collapsed, onToggleCollapse }: SidebarProps) {
  const { toast } = useToast();

  const triggerIncident  = useTriggerIncident();
  const sigkill          = useSigkillProcess();
  const simulateWebhook  = useSimulateCloudwatchWebhook();
  const ingestMetrics    = useIngestMetrics();
  const seedMemory       = useSeedVectorMemory();

  const [scenario,           setScenario]           = useState(PRESET_SCENARIOS[0]);
  const [customText,         setCustomText]         = useState("");
  const [chaosMode,          setChaosMode]          = useState("none");
  const [cwAlarm,            setCwAlarm]            = useState("checkout-5xx-spike");
  const [cwReason,           setCwReason]           = useState("Threshold Crossed: 3 out of 3 datapoints > 10");
  const [predictiveScenario, setPredictiveScenario] = useState(PREDICTIVE_SCENARIOS[0]);

  // ── Trigger ──────────────────────────────────────────────────────────────
  const handleTrigger = () => {
    triggerIncident.mutate(
      {
        data: {
          alertText: customText.trim() || scenario,
          chaosMode: chaosMode === "none" || chaosMode === "sigkill" ? undefined : (chaosMode as "latency" | "partition"),
          simulateCrash: chaosMode === "sigkill",
        },
      },
      {
        onSuccess: (res) => {
          toast({
            title: "Incident Triggered",
            description: `${res.status} · ${res.incidentId.slice(0, 8)}`,
          });
        },
        onError: (err) => {
          toast({ title: "Trigger Failed", description: String(err), variant: "destructive" });
        },
      },
    );
  };

  // ── Predictive ────────────────────────────────────────────────────────────
  const handlePredictive = () => {
    const map: Record<string, object[]> = {
      "ECS CPU spike (pre-alarm)":          [{ metricName: "CPUUtilization",     value: 84,         dimensions: { ServiceName: "checkout" },      serviceHint: "checkout" }],
      "RDS connections approaching limit":  [{ metricName: "DatabaseConnections", value: 430,        dimensions: { ClusterName: "polite-genie" },  serviceHint: "polite-genie" }],
      "Lambda throttling pre-alarm":        [{ metricName: "Throttles",           value: 12,         dimensions: { FunctionName: "order-processor" }, serviceHint: "order-processor" }],
      "High ALB response time":             [{ metricName: "TargetResponseTime",  value: 2.8,        dimensions: { ServiceName: "checkout" },      serviceHint: "checkout" }],
      "Disk usage critical":                [{ metricName: "FreeableStorage",     value: 500000000,  dimensions: { ServiceName: "api" },           serviceHint: "api" }],
    };
    const datapoints = map[predictiveScenario];
    if (!datapoints) return;

    ingestMetrics.mutate(
      { data: { datapoints } } as Parameters<typeof ingestMetrics.mutate>[0],
      {
        onSuccess: () => {
          toast({ title: "Metrics Ingested", description: "Anomaly detection pipeline notified." });
        },
        onError: (err) => {
          toast({ title: "Ingest Failed", description: String(err), variant: "destructive" });
        },
      },
    );
  };

  // ── Webhook ───────────────────────────────────────────────────────────────
  const handleWebhook = () => {
    simulateWebhook.mutate(
      { data: { AlarmName: cwAlarm, NewStateReason: cwReason } } as Parameters<typeof simulateWebhook.mutate>[0],
      {
        onSuccess: () => {
          toast({ title: "Webhook Sent", description: `Alarm: ${cwAlarm}` });
        },
        onError: (err) => {
          toast({ title: "Webhook Failed", description: String(err), variant: "destructive" });
        },
      },
    );
  };

  // ── SIGKILL ───────────────────────────────────────────────────────────────
  const handleSigkill = () => {
    sigkill.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "SIGKILL Sent", description: "API server will restart momentarily." });
      },
      onError: (err) => {
        toast({ title: "SIGKILL Failed", description: String(err), variant: "destructive" });
      },
    });
  };

  // ── Seed memory ───────────────────────────────────────────────────────────
  const handleSeed = () => {
    seedMemory.mutate(undefined, {
      onSuccess: (res) => {
        toast({ title: "Vector Memory Reset", description: (res as { message?: string }).message ?? "Done." });
      },
      onError: (err) => {
        toast({ title: "Seed Failed", description: String(err), variant: "destructive" });
      },
    });
  };

  // ── Shared button style ───────────────────────────────────────────────────
  const sidebarBtn = (color?: "primary" | "purple" | "cyan" | "destructive") => {
    const base = "w-full h-9 rounded-sm font-mono text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2 border";
    const map: Record<string, string> = {
      primary:     "bg-primary/10 border-primary/40 text-primary hover:bg-primary/20 hover:border-primary/60",
      purple:      "bg-purple-500/10 border-purple-500/30 text-purple-300 hover:bg-purple-500/20 hover:border-purple-500/50",
      cyan:        "bg-cyan-500/10 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-500/50",
      destructive: "bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20 hover:border-red-500/50",
    };
    return cn(base, color ? map[color] : map.primary);
  };

  return (
    <aside
      className={cn(
        "flex-shrink-0 border-l border-border bg-sidebar flex flex-col h-full z-50 overflow-hidden",
        "md:transition-[width] md:duration-200 md:ease-in-out",
        collapsed ? "md:w-10" : "md:w-72",
        "w-72",
        "fixed top-0 right-0 transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "translate-x-full",
        "md:static md:translate-x-0 md:transition-[width]",
      )}
    >
      {/* ── Collapsed strip (desktop only) ─────────────────────────────── */}
      {collapsed && (
        <div className="hidden md:flex flex-col items-center pt-4 gap-3 flex-1">
          <button
            onClick={onToggleCollapse}
            className="w-7 h-7 flex items-center justify-center rounded-sm text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-border/30 transition-colors"
            aria-label="Expand controls"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span
            className="text-[10px] font-mono uppercase tracking-widest text-sidebar-foreground/40 select-none"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Controls
          </span>
        </div>
      )}

      {/* ── Full panel ─────────────────────────────────────────────────── */}
      <div className={cn("flex flex-col flex-1 overflow-hidden", collapsed ? "md:hidden" : "")}>

        {/* Header */}
        <div className="h-14 px-4 flex items-center justify-between border-b border-sidebar-border shrink-0">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-primary" />
            <span className="font-mono font-bold text-sm uppercase tracking-tight text-sidebar-foreground">Controls</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleCollapse}
              className="hidden md:flex items-center justify-center w-6 h-6 rounded-sm text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-border/30 transition-colors"
              aria-label="Collapse controls"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onClose}
              className="md:hidden flex items-center justify-center w-6 h-6 rounded-sm text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-border/30 transition-colors"
              aria-label="Close controls"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">

          {/* ── Trigger Incident ───────────────────────────────────────── */}
          <section className="space-y-3">
            <SectionHeader
              icon={<AlertTriangle className="w-3.5 h-3.5" />}
              label="Trigger Incident"
              color="text-primary"
            />
            <div>
              <FieldLabel>Scenario</FieldLabel>
              <PanelSelect
                value={scenario}
                onChange={setScenario}
                options={PRESET_SCENARIOS.map((s) => ({ value: s, label: s }))}
              />
            </div>
            <div>
              <FieldLabel>Custom Alert Text</FieldLabel>
              <SidebarTextarea
                value={customText}
                onChange={setCustomText}
                placeholder="Paste PagerDuty payload or free-text alert..."
              />
            </div>
            <div>
              <FieldLabel>Chaos Engineering</FieldLabel>
              <PanelSelect
                value={chaosMode}
                onChange={setChaosMode}
                options={CHAOS_OPTIONS}
              />
            </div>
            <button
              onClick={handleTrigger}
              disabled={triggerIncident.isPending}
              className={sidebarBtn("primary")}
            >
              {triggerIncident.isPending ? (
                <>
                  <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  Triggering...
                </>
              ) : triggerIncident.isSuccess ? (
                <><CheckCircle className="w-3.5 h-3.5" /> Triggered</>
              ) : triggerIncident.isError ? (
                <><AlertCircle className="w-3.5 h-3.5 text-red-400" /><span className="text-red-400">Failed</span></>
              ) : (
                "Trigger Agent"
              )}
            </button>
          </section>

          <div className="h-px bg-sidebar-border/40" />

          {/* ── Predictive Injection ───────────────────────────────────── */}
          <section className="space-y-3">
            <SectionHeader
              icon={<Activity className="w-3.5 h-3.5" />}
              label="Predictive Injection"
              color="text-purple-400"
            />
            <PanelSelect
              value={predictiveScenario}
              onChange={setPredictiveScenario}
              options={PREDICTIVE_SCENARIOS.map((s) => ({ value: s, label: s }))}
            />
            <button
              onClick={handlePredictive}
              disabled={ingestMetrics.isPending}
              className={sidebarBtn("purple")}
            >
              {ingestMetrics.isPending ? (
                <>
                  <span className="w-3 h-3 border-2 border-purple-500/30 border-t-purple-400 rounded-full animate-spin" />
                  Injecting...
                </>
              ) : ingestMetrics.isSuccess ? (
                <><CheckCircle className="w-3.5 h-3.5" /> Injected</>
              ) : (
                "Ingest Anomaly Metric"
              )}
            </button>
          </section>

          <div className="h-px bg-sidebar-border/40" />

          {/* ── CloudWatch Webhook ─────────────────────────────────────── */}
          <section className="space-y-3">
            <SectionHeader
              icon={<Zap className="w-3.5 h-3.5" />}
              label="CloudWatch Webhook"
              color="text-cyan-400"
            />
            <div>
              <FieldLabel>Alarm Name</FieldLabel>
              <SidebarInput value={cwAlarm} onChange={setCwAlarm} placeholder="checkout-5xx-spike" />
            </div>
            <div>
              <FieldLabel>New State Reason</FieldLabel>
              <SidebarInput value={cwReason} onChange={setCwReason} placeholder="Threshold Crossed..." />
            </div>
            <button
              onClick={handleWebhook}
              disabled={simulateWebhook.isPending}
              className={sidebarBtn("cyan")}
            >
              {simulateWebhook.isPending ? (
                <>
                  <span className="w-3 h-3 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
                  Sending...
                </>
              ) : simulateWebhook.isSuccess ? (
                <><CheckCircle className="w-3.5 h-3.5" /> Sent</>
              ) : (
                "Simulate Webhook"
              )}
            </button>
          </section>

          <div className="h-px bg-sidebar-border/40" />

          {/* ── System Ops ─────────────────────────────────────────────── */}
          <section className="space-y-2">
            <SectionHeader
              icon={<Server className="w-3.5 h-3.5" />}
              label="System Ops"
              color="text-sidebar-foreground/70"
            />
            <button
              onClick={handleSigkill}
              disabled={sigkill.isPending}
              className={sidebarBtn("destructive")}
            >
              {sigkill.isPending ? (
                <>
                  <span className="w-3 h-3 border-2 border-red-500/30 border-t-red-400 rounded-full animate-spin" />
                  Sending SIGKILL...
                </>
              ) : (
                "SIGKILL API Server"
              )}
            </button>
            <button
              onClick={handleSeed}
              disabled={seedMemory.isPending}
              className={cn(sidebarBtn(), "border-sidebar-border/50 text-sidebar-foreground/80 bg-sidebar-border/10 hover:bg-sidebar-border/25 hover:text-sidebar-foreground")}
            >
              {seedMemory.isPending ? (
                <>
                  <span className="w-3 h-3 border-2 border-sidebar-foreground/20 border-t-sidebar-foreground/60 rounded-full animate-spin" />
                  Seeding...
                </>
              ) : seedMemory.isSuccess ? (
                <><CheckCircle className="w-3.5 h-3.5" /> Memory Reset</>
              ) : (
                "Reset Vector Memory"
              )}
            </button>
          </section>

        </div>
      </div>
    </aside>
  );
}
