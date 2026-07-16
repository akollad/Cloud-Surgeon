import { useGetImpactMetrics } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BarChart2, TrendingDown, DollarSign, Clock } from "lucide-react";

export default function Impact() {
  const { data: metrics } = useGetImpactMetrics({ query: { refetchInterval: 10000 } });

  const toMin = (seconds: number | null | undefined) =>
    seconds != null ? seconds / 60 : null;

  const formatMin = (val: number | null | undefined) =>
    val != null ? val.toFixed(1) + "m" : "—";
  const formatPct = (val: number | null | undefined) =>
    val != null ? val.toFixed(1) + "%" : "—";
  const formatUsd = (val: number | null | undefined) =>
    val != null
      ? "$" + val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";

  const mttr = metrics?.mttrStats;
  const cost = metrics?.costStats;
  const autonomy = metrics?.autonomyBreakdown;
  const total = metrics?.totalIncidents || 1;

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <BarChart2 className="mr-2 h-5 w-5 text-primary" />
          Impact & Cost Analysis
        </h1>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center">
              <Clock className="w-4 h-4 mr-2" /> Agent MTTR
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-cyan-400">
              {formatMin(toMin(mttr?.avgSeconds))}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              vs {formatMin(toMin(mttr?.humanBaselineSeconds))} human baseline
            </div>
            {(mttr as any)?.outlierCount > 0 && (
              <div className="text-xs text-yellow-500/70 mt-1">
                {(mttr as any).outlierCount} stuck incident{(mttr as any).outlierCount > 1 ? "s" : ""} excluded
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center">
              <TrendingDown className="w-4 h-4 mr-2" /> MTTR Reduction
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-green-400">
              {formatPct(mttr?.reductionPct)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Faster resolution time</div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center">
              <DollarSign className="w-4 h-4 mr-2" /> Cost Saved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-primary">
              {formatUsd(cost?.estimatedSavingsUsd)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              vs {formatUsd(cost?.humanTotalCostIfManual)} manual baseline
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center">
              <BarChart2 className="w-4 h-4 mr-2" /> Resolution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-mono font-bold text-foreground">
              {metrics?.incidentsResolved || 0}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              of {metrics?.totalIncidents || 0} total incidents
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Routing distribution */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle>Routing Distribution</CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4 font-mono text-sm">
            {[
              { label: "AUTONOMOUS",       value: autonomy?.autonomous,     color: "bg-green-500",  text: "text-green-400"  },
              { label: "PENDING_APPROVAL", value: autonomy?.pendingApproval, color: "bg-yellow-500", text: "text-yellow-400" },
              { label: "EXPLORATORY",      value: autonomy?.exploratory,    color: "bg-blue-500",   text: "text-blue-400"   },
              { label: "REJECTED",         value: autonomy?.rejected,       color: "bg-red-500",    text: "text-red-400"    },
            ].map(({ label, value, color, text }) => (
              <div key={label}>
                <div className="flex items-center justify-between mb-1">
                  <span className={text}>{label}</span>
                  <span className="text-foreground">{value ?? 0}</span>
                </div>
                <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
                  <div
                    className={`${color} h-full transition-all duration-500`}
                    style={{ width: `${((value ?? 0) / total) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="pt-3 border-t border-border/50 flex justify-between text-muted-foreground">
              <span>Total Processed</span>
              <span>{metrics?.totalIncidents ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        {/* Cost breakdown */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle>Cost Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-3 font-mono text-sm">
            {[
              { label: "Agent cost (est.)",    value: formatUsd(cost?.estimatedAgentCostUsd),           color: "text-primary"        },
              { label: "Manual baseline",      value: formatUsd(cost?.humanTotalCostIfManual),           color: "text-muted-foreground" },
              { label: "Savings",              value: formatUsd(cost?.estimatedSavingsUsd),              color: "text-green-400"       },
              { label: "RU consumed",          value: cost?.totalRuConsumed != null ? cost.totalRuConsumed.toLocaleString() : "—", color: "text-cyan-400" },
              { label: "Avg RU / incident",    value: cost?.avgRuPerIncident != null ? cost.avgRuPerIncident.toFixed(1) : "—",     color: "text-foreground" },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex justify-between items-center border-b border-border/30 pb-2 last:border-0 last:pb-0">
                <span className="text-muted-foreground">{label}</span>
                <span className={`font-bold ${color}`}>{value}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* MTTR by strategy */}
      {metrics?.mttrByStrategy && metrics.mttrByStrategy.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle>MTTR by Strategy</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Incidents resolved in &gt;30 min excluded (stuck during server restarts).
            </p>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full font-mono text-xs min-w-[500px]">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-left">
                  <th className="px-4 py-2.5 font-medium">Strategy</th>
                  <th className="px-4 py-2.5 font-medium text-right">Count</th>
                  <th className="px-4 py-2.5 font-medium text-right">Avg MTTR</th>
                  <th className="px-4 py-2.5 font-medium text-right">Min</th>
                  <th className="px-4 py-2.5 font-medium text-right">Max</th>
                </tr>
              </thead>
              <tbody>
                {metrics.mttrByStrategy.map((s: any, i: number) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="px-4 py-2.5 text-cyan-400">{s.strategyName}</td>
                    <td className="px-4 py-2.5 text-right text-foreground">{s.incidentCount}</td>
                    <td className="px-4 py-2.5 text-right text-foreground">{formatMin(toMin(s.mttrAvgSeconds))}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">{formatMin(toMin(s.mttrMinSeconds))}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">{formatMin(toMin(s.mttrMaxSeconds))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
