import { useGetImpactMetrics } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BarChart2, TrendingDown, DollarSign, Clock } from "lucide-react";

export default function Impact() {
  const { data: metrics } = useGetImpactMetrics({ query: { refetchInterval: 10000 } });

  const formatMin = (val: number | null | undefined) => val ? val.toFixed(1) + "m" : "—";
  const formatPct = (val: number | null | undefined) => val ? val.toFixed(1) + "%" : "—";
  const formatUsd = (val: number | null | undefined) => val ? "$" + val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <BarChart2 className="mr-2 h-5 w-5 text-primary" />
          Impact & Cost Analysis
        </h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center"><Clock className="w-4 h-4 mr-2"/> Agent MTTR</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-cyan-400">{formatMin(metrics?.avgAgentMttrMinutes)}</div>
            <div className="text-xs text-muted-foreground mt-1">vs {formatMin(metrics?.humanBaselineMttrMinutes)} human baseline</div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center"><TrendingDown className="w-4 h-4 mr-2"/> MTTR Reduction</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-green-400">{formatPct(metrics?.mttrSavingsPercent)}</div>
            <div className="text-xs text-muted-foreground mt-1">Faster resolution time</div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center"><DollarSign className="w-4 h-4 mr-2"/> Cost Saved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-primary">{formatUsd(metrics?.estimatedCostSavingsUsd)}</div>
            <div className="text-xs text-muted-foreground mt-1">Based on downtime cost/min</div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center"><BarChart2 className="w-4 h-4 mr-2"/> Resolution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-foreground">{metrics?.resolvedCount || 0}</div>
            <div className="text-xs text-muted-foreground mt-1">Total incidents resolved</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
        <Card>
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle>Routing Distribution</CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4 font-mono text-sm">
            <div className="flex items-center justify-between">
              <span className="text-green-400">AUTONOMOUS</span>
              <span className="text-foreground">{metrics?.autonomousCount || 0}</span>
            </div>
            <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
               <div className="bg-green-500 h-full" style={{ width: `${((metrics?.autonomousCount || 0) / (metrics?.totalIncidents || 1)) * 100}%` }} />
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-yellow-400">PENDING_APPROVAL</span>
              <span className="text-foreground">{metrics?.pendingApprovalCount || 0}</span>
            </div>
            <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
               <div className="bg-yellow-500 h-full" style={{ width: `${((metrics?.pendingApprovalCount || 0) / (metrics?.totalIncidents || 1)) * 100}%` }} />
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-blue-400">EXPLORATORY</span>
              <span className="text-foreground">{metrics?.exploratoryCount || 0}</span>
            </div>
            <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
               <div className="bg-blue-500 h-full" style={{ width: `${((metrics?.exploratoryCount || 0) / (metrics?.totalIncidents || 1)) * 100}%` }} />
            </div>
            
            <div className="pt-4 mt-2 border-t border-border/50 flex justify-between text-muted-foreground">
              <span>Total Processed</span>
              <span>{metrics?.totalIncidents || 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
