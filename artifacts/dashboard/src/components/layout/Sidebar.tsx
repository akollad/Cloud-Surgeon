import { useState } from "react";
import { useTriggerIncident, useSigkillProcess, useSimulateCloudwatchWebhook, useIngestMetrics, useSeedVectorMemory } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Server, Activity, AlertTriangle, Zap, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";

const PRESET_SCENARIOS = [
  "Payment service 5xx spike (ECS)",
  "Primary DB CPU saturation (RDS)",
  "Cascading Lambda throttling",
  "Worker node disk full",
  "JVM memory leak (recommendation service)",
  "DB connection pool exhausted (Postgres RDS)",
  "Cross-region latency > SLA (API Gateway)",
  "Expired AWS credential (S3 access from ECS)",
  "External dependency down (Stripe API)",
  "Unknown incident (exploratory scenario)",
];

const PREDICTIVE_SCENARIOS = [
  "ECS CPU spike (pre-alarm)",
  "RDS connections approaching limit",
  "Lambda throttling pre-alarm",
  "High ALB response time",
  "Disk usage critical",
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const triggerIncident = useTriggerIncident();
  const sigkill = useSigkillProcess();
  const simulateWebhook = useSimulateCloudwatchWebhook();
  const ingestMetrics = useIngestMetrics();
  const seedMemory = useSeedVectorMemory();

  const [scenario, setScenario] = useState(PRESET_SCENARIOS[0]);
  const [customText, setCustomText] = useState("");
  const [chaosMode, setChaosMode] = useState("None");
  const [cwAlarm, setCwAlarm] = useState("checkout-5xx-spike");
  const [cwReason, setCwReason] = useState("Threshold Crossed: 3 out of 3 datapoints > 10");
  const [predictiveScenario, setPredictiveScenario] = useState(PREDICTIVE_SCENARIOS[0]);

  const handleTrigger = () => {
    triggerIncident.mutate({
      data: {
        alertText: customText.trim() || scenario,
        chaosMode: chaosMode === "None" ? undefined : chaosMode,
        simulateCrash: chaosMode === "SIGKILL crash after diagnostic",
      },
    });
  };

  const handlePredictive = () => {
    const map: Record<string, object[]> = {
      "ECS CPU spike (pre-alarm)": [{ metricName: "CPUUtilization", value: 84, dimensions: { ServiceName: "checkout-ecs" }, serviceHint: "checkout-ecs" }],
      "RDS connections approaching limit": [{ metricName: "DatabaseConnections", value: 430, dimensions: { DBInstanceIdentifier: "catalog-db" }, serviceHint: "catalog-db" }],
      "Lambda throttling pre-alarm": [{ metricName: "Throttles", value: 12, dimensions: { FunctionName: "order-processor" }, serviceHint: "order-processor" }],
      "High ALB response time": [{ metricName: "TargetResponseTime", value: 2.8, dimensions: { LoadBalancer: "app/checkout-alb" }, serviceHint: "checkout-alb" }],
      "Disk usage critical": [{ metricName: "FreeableStorage", value: 500000000, dimensions: { InstanceId: "i-0abc123" }, serviceHint: "worker-03" }],
    };
    const datapoints = map[predictiveScenario];
    if (datapoints) ingestMetrics.mutate({ data: { datapoints } } as any);
  };

  return (
    <aside
      className={cn(
        "w-72 flex-shrink-0 border-l border-border bg-sidebar flex flex-col h-full overflow-y-auto overflow-x-hidden z-50",
        // Mobile: fixed overlay from the right
        "fixed top-0 right-0 transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "translate-x-full",
        // Desktop: always in flow
        "md:static md:translate-x-0 md:transition-none"
      )}
    >
      {/* Header */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="font-mono font-bold text-sm uppercase tracking-tight text-foreground">Controls</span>
        </div>
        <button
          onClick={onClose}
          className="md:hidden w-6 h-6 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Close controls"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-5 flex-1">

        {/* Trigger Incident */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-primary">
            <AlertTriangle className="w-3.5 h-3.5" />
            <h2 className="font-mono text-[11px] uppercase font-bold tracking-wider">Trigger Incident</h2>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-mono text-muted-foreground">Scenario</label>
            <Select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {PRESET_SCENARIOS.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-mono text-muted-foreground">Custom Alert Text</label>
            <Textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Paste PagerDuty payload or text here..."
              className="font-mono text-xs h-16"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-mono text-muted-foreground">Chaos Engineering</label>
            <Select value={chaosMode} onChange={(e) => setChaosMode(e.target.value)}>
              <option>None</option>
              <option>Network latency (500ms)</option>
              <option>DB partition (2 timeouts)</option>
              <option>SIGKILL crash after diagnostic</option>
            </Select>
          </div>

          <Button className="w-full" onClick={handleTrigger} disabled={triggerIncident.isPending}>
            {triggerIncident.isPending ? "Triggering..." : "Trigger Agent"}
          </Button>
        </section>

        <div className="h-px bg-border" />

        {/* Predictive Anomaly */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-purple-400">
            <Activity className="w-3.5 h-3.5" />
            <h2 className="font-mono text-[11px] uppercase font-bold tracking-wider">Predictive Injection</h2>
          </div>
          <Select value={predictiveScenario} onChange={(e) => setPredictiveScenario(e.target.value)}>
            {PREDICTIVE_SCENARIOS.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Button
            variant="outline"
            className="w-full text-purple-400 border-purple-500/30 hover:bg-purple-500/10 hover:text-purple-300"
            onClick={handlePredictive}
            disabled={ingestMetrics.isPending}
          >
            Ingest Anomaly Metric
          </Button>
        </section>

        <div className="h-px bg-border" />

        {/* CloudWatch Webhook */}
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-cyan-400">
            <Zap className="w-3.5 h-3.5" />
            <h2 className="font-mono text-[11px] uppercase font-bold tracking-wider">CloudWatch Webhook</h2>
          </div>
          <div className="space-y-1.5">
            <Input value={cwAlarm} onChange={(e) => setCwAlarm(e.target.value)} placeholder="Alarm Name" className="text-xs" />
            <Input value={cwReason} onChange={(e) => setCwReason(e.target.value)} placeholder="NewStateReason" className="text-xs" />
          </div>
          <Button
            variant="outline"
            className="w-full text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/10 hover:text-cyan-300"
            onClick={() => simulateWebhook.mutate({ data: { AlarmName: cwAlarm, NewStateReason: cwReason } })}
            disabled={simulateWebhook.isPending}
          >
            Simulate Webhook
          </Button>
        </section>

        <div className="h-px bg-border" />

        {/* System Ops */}
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Server className="w-3.5 h-3.5" />
            <h2 className="font-mono text-[11px] uppercase font-bold tracking-wider">System Ops</h2>
          </div>
          <Button
            variant="destructive"
            className="w-full text-xs h-8"
            onClick={() => sigkill.mutate(undefined)}
            disabled={sigkill.isPending}
          >
            SIGKILL API Server
          </Button>
          <Button
            variant="outline"
            className="w-full text-xs h-8"
            onClick={() => seedMemory.mutate(undefined)}
            disabled={seedMemory.isPending}
          >
            Reset Vector Memory
          </Button>
        </section>

      </div>
    </aside>
  );
}
