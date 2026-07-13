import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function JudgeGuide() {
  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="space-y-4 border-b border-border pb-6">
        <h1 className="text-3xl font-mono font-bold tracking-tighter uppercase text-primary">Cloud-Surgeon: Demo Guide</h1>
        <p className="text-muted-foreground text-sm max-w-3xl leading-relaxed">
          Welcome to the evaluation environment for Cloud-Surgeon. This dashboard visualizes an autonomous multi-agent system executing SRE runbooks. The system consists of three specialized agents (Diagnostician, Remediator, Auditor) working over CockroachDB vector memory to resolve, escalate, or observe AWS infrastructure incidents.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-card">
          <CardHeader className="pb-2 border-b-0">
            <CardTitle className="text-purple-400">1. Diagnostician</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Ingests alerts, runs initial triage (CloudWatch, ECS, RDS APIs), matches against vector memory for past successful runbooks, and proposes a strategy.
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="pb-2 border-b-0">
            <CardTitle className="text-cyan-400">2. Remediator</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Executes the chosen runbook. If autonomous, acts immediately. If high risk / low confidence, routes to PENDING_APPROVAL.
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="pb-2 border-b-0">
            <CardTitle className="text-green-400">3. Auditor</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Validates fix via causal chain analysis. Records success/failure back to CockroachDB to recalibrate the strategy's Win-Rate for future routing.
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6 pt-4">
        <h2 className="text-xl font-mono font-bold tracking-tight uppercase border-l-4 border-primary pl-3">Evaluation Scenarios</h2>
        <div className="space-y-4">
          
          <Card className="border-l-4 border-l-green-500">
            <CardHeader className="py-3 cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex justify-between items-center">
                <CardTitle className="text-foreground">A. Autonomous Resolution (High Confidence)</CardTitle>
                <Badge variant="autonomous">AUTONOMOUS</Badge>
              </div>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed pt-0">
              <p className="mb-2"><strong>Trigger:</strong> Select "Payment service 5xx spike (ECS)".</p>
              <p><strong>Flow:</strong> The agent recognizes this exact signature from memory with a high win-rate. It instantly restarts the ECS tasks, validates the fix, and closes the incident. No human needed. Check the <span className="text-primary">/live</span> tab to watch the execution.</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-yellow-500">
            <CardHeader className="py-3 cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex justify-between items-center">
                <CardTitle className="text-foreground">B. Human-in-the-Loop (Low Confidence)</CardTitle>
                <Badge variant="pending_approval">PENDING_APPROVAL</Badge>
              </div>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed pt-0">
              <p className="mb-2"><strong>Trigger:</strong> Select "Cascading Lambda throttling".</p>
              <p><strong>Flow:</strong> The system matches a strategy but sees its historical win-rate is too low or sample size too small. It pauses. Go to the <span className="text-primary">/incidents</span> tab to Approve or Reject the proposed action.</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-red-500">
            <CardHeader className="py-3 cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex justify-between items-center">
                <CardTitle className="text-foreground">C. Crash Recovery (Resilience)</CardTitle>
                <Badge variant="destructive">CRASH / RECOVER</Badge>
              </div>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed pt-0">
              <p className="mb-2"><strong>Trigger:</strong> Select any scenario, set Chaos Mode to "SIGKILL crash after diagnostic".</p>
              <p><strong>Flow:</strong> The process is killed mid-flight. When the process restarts (automatic in Replit), the incident is picked back up from exactly where it left off using state hydrated from CockroachDB. Check <span className="text-primary">/decision</span> for the routing mode.</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-blue-500">
            <CardHeader className="py-3 cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex justify-between items-center">
                <CardTitle className="text-foreground">D. Exploratory Diagnosis</CardTitle>
                <Badge variant="exploratory">EXPLORATORY</Badge>
              </div>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed pt-0">
              <p className="mb-2"><strong>Trigger:</strong> Select "Unknown incident (exploratory scenario)".</p>
              <p><strong>Flow:</strong> No vector match is found. The agent switches to read-only exploratory mode, queries AWS APIs to build context, and safely fails the incident for human review without taking destructive action.</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-purple-500">
            <CardHeader className="py-3 cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex justify-between items-center">
                <CardTitle className="text-foreground">E. Predictive Anomaly Prevention</CardTitle>
                <Badge variant="predictive">PREDICTIVE</Badge>
              </div>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed pt-0">
              <p className="mb-2"><strong>Trigger:</strong> In the sidebar, select "ECS CPU spike (pre-alarm)" and click Ingest Anomaly Metric.</p>
              <p><strong>Flow:</strong> The system ingests a metric *before* it breaches an alarm threshold, predicts an impending incident based on historical trends, and proactively mitigates it before users are affected.</p>
            </CardContent>
          </Card>
        </div>
      </div>

    </div>
  );
}
