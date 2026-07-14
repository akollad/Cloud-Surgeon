import { useState } from "react";
import { useTriggerIncident, useSigkillProcess, useSimulateCloudwatchWebhook, useIngestMetrics, useSeedVectorMemory, useHealthCheck } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Server, Activity, AlertTriangle, Database, Zap, Clock, Terminal, X } from "lucide-react";
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
  "Disk usage critical"
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
  const { data: health } = useHealthCheck(undefined, { query: { refetchInterval: 5000 } });

  // Form states
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
        simulateCrash: chaosMode === "SIGKILL crash after diagnostic"
      }
    });
  };

  const handlePredictive = () => {
    let datapoints: any[] = [];
    if (predictiveScenario === "ECS CPU spike (pre-alarm)") {
      datapoints = [{ metricName: "CPUUtilization", value: 84, dimensions: { ServiceName: "checkout-ecs" }, serviceHint: "checkout-ecs" }];
    } else if (predictiveScenario === "RDS connections approaching limit") {
      datapoints = [{ metricName: "DatabaseConnections", value: 430, dimensions: { DBInstanceIdentifier: "catalog-db" }, serviceHint: "catalog-db" }];
    } else if (predictiveScenario === "Lambda throttling pre-alarm") {
      datapoints = [{ metricName: "Throttles", value: 12, dimensions: { FunctionName: "order-processor" }, serviceHint: "order-processor" }];
    } else if (predictiveScenario === "High ALB response time") {
      datapoints = [{ metricName: "TargetResponseTime", value: 2.8, dimensions: { LoadBalancer: "app/checkout-alb" }, serviceHint: "checkout-alb" }];
    } else if (predictiveScenario === "Disk usage critical") {
      datapoints = [{ metricName: "FreeableStorage", value: 500000000, dimensions: { InstanceId: "i-0abc123" }, serviceHint: "worker-03" }];
    }

    if (datapoints.length) {
      ingestMetrics.mutate({ data: { datapoints } });
    }
  };

  return (
    <aside
      className={cn(
        // Shared
        "w-80 flex-shrink-0 border-r border-border bg-sidebar flex flex-col h-full overflow-y-auto overflow-x-hidden z-50",
        // Mobile: fixed overlay, slides in/out
        "fixed top-0 left-0 transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "-translate-x-full",
        // Desktop: always visible, static in flow
        "md:static md:translate-x-0 md:transition-none"
      )}
    >
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between sticky top-0 bg-sidebar z-10">
        <div className="flex items-center space-x-2">
          <Terminal className="w-5 h-5 text-primary" />
          <h1 className="font-mono font-bold tracking-tighter uppercase text-lg text-foreground">Cloud-Surgeon</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={health ? "text-green-500 border-green-500/30" : "text-red-500 border-red-500/30"}>
            {health ? "API ONLINE" : "OFFLINE"}
          </Badge>
          {/* Close button — mobile only */}
          <button
            onClick={onClose}
            className="md:hidden flex items-center justify-center w-7 h-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Close sidebar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-6">

        {/* Trigger Incident */}
        <section className="space-y-3">
          <div className="flex items-center space-x-2 text-primary">
            <AlertTriangle className="w-4 h-4" />
            <h2 className="font-mono text-xs uppercase font-bold tracking-wider">Trigger Incident</h2>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] uppercase font-mono text-muted-foreground">Scenario</label>
            <Select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {PRESET_SCENARIOS.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] uppercase font-mono text-muted-foreground">Custom Alert Text (Overrides Scenario)</label>
            <Textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Paste PagerDuty payload or text here..."
              className="font-mono text-xs h-20"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] uppercase font-mono text-muted-foreground">Chaos Engineering</label>
            <Select value={chaosMode} onChange={(e) => setChaosMode(e.target.value)}>
              <option>None</option>
              <option>Network latency (500ms)</option>
              <option>DB partition (2 timeouts)</option>
              <option>SIGKILL crash after diagnostic</option>
            </Select>
          </div>

          <Button
            className="w-full mt-2"
            onClick={handleTrigger}
            disabled={triggerIncident.isPending}
          >
            {triggerIncident.isPending ? "Triggering..." : "Trigger Agent"}
          </Button>
        </section>

        <div className="h-px bg-border w-full" />

        {/* Predictive Anomaly */}
        <section className="space-y-3">
          <div className="flex items-center space-x-2 text-purple-400">
            <Activity className="w-4 h-4" />
            <h2 className="font-mono text-xs uppercase font-bold tracking-wider">Predictive Injection</h2>
          </div>
          <div className="space-y-2">
            <Select value={predictiveScenario} onChange={(e) => setPredictiveScenario(e.target.value)}>
              {PREDICTIVE_SCENARIOS.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <Button
            variant="outline"
            className="w-full text-purple-400 border-purple-500/30 hover:bg-purple-500/10 hover:text-purple-300"
            onClick={handlePredictive}
            disabled={ingestMetrics.isPending}
          >
            Ingest Anomaly Metric
          </Button>
        </section>

        <div className="h-px bg-border w-full" />

        {/* CloudWatch Webhook */}
        <section className="space-y-3">
          <div className="flex items-center space-x-2 text-cyan-400">
            <Zap className="w-4 h-4" />
            <h2 className="font-mono text-xs uppercase font-bold tracking-wider">CloudWatch Webhook</h2>
          </div>
          <div className="space-y-2">
            <Input
              value={cwAlarm}
              onChange={e => setCwAlarm(e.target.value)}
              placeholder="Alarm Name"
              className="text-xs"
            />
            <Input
              value={cwReason}
              onChange={e => setCwReason(e.target.value)}
              placeholder="NewStateReason"
              className="text-xs"
            />
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

        <div className="h-px bg-border w-full" />

        {/* System Operations */}
        <section className="space-y-3">
          <div className="flex items-center space-x-2 text-muted-foreground">
            <Server className="w-4 h-4" />
            <h2 className="font-mono text-xs uppercase font-bold tracking-wider">System Ops</h2>
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
