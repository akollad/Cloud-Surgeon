import { useState, useEffect, useRef } from "react";
import { useGetImpactMetrics } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BarChart2, TrendingDown, DollarSign, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

const PAGE_SIZE = 5;

/* ── animated counter on mount ─────────────────────────────────────── */
function useAnimatedValue(target: number | null | undefined, duration = 700) {
  const [value, setValue] = useState(0);
  const raf = useRef<number>();
  useEffect(() => {
    if (target == null) return;
    const start = performance.now();
    const to = target;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(to * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else setValue(to);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target, duration]);
  return value;
}

/* ── custom tooltip ─────────────────────────────────────────────────── */
const DarkTooltip = ({ active, payload, label, formatter }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border border-border/60 rounded-lg px-3 py-2 shadow-xl text-xs font-mono">
      {label && <p className="text-muted-foreground mb-1">{label}</p>}
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color ?? p.fill }}>
          {p.name}: <span className="font-bold">{formatter ? formatter(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
};

const PIE_COLORS: Record<string, string> = {
  AUTONOMOUS: "#4ade80",
  PENDING_APPROVAL: "#facc15",
  EXPLORATORY: "#60a5fa",
  REJECTED: "#f87171",
};

export default function Impact() {
  const { data: metrics } = useGetImpactMetrics({ query: { refetchInterval: 10000 } });
  const [page, setPage] = useState(0);

  const toMin = (s: number | null | undefined) => (s != null ? s / 60 : null);
  const formatMin = (v: number | null | undefined) => (v != null ? v.toFixed(1) + "m" : "—");
  const formatPct = (v: number | null | undefined) => (v != null ? v.toFixed(1) + "%" : "—");
  const formatUsd = (v: number | null | undefined) =>
    v != null
      ? "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";

  const mttr = metrics?.mttrStats;
  const cost = metrics?.costStats;
  const autonomy = metrics?.autonomyBreakdown;
  const total = metrics?.totalIncidents || 1;

  /* animated KPI values */
  const animMttr   = useAnimatedValue(toMin(mttr?.avgSeconds));
  const animReduc  = useAnimatedValue(mttr?.reductionPct);
  const animSaved  = useAnimatedValue(cost?.estimatedSavingsUsd);
  const animResolved = useAnimatedValue(metrics?.incidentsResolved);

  /* pie data */
  const pieData = [
    { name: "AUTONOMOUS",       value: autonomy?.autonomous     ?? 0 },
    { name: "PENDING_APPROVAL", value: autonomy?.pendingApproval ?? 0 },
    { name: "EXPLORATORY",      value: autonomy?.exploratory    ?? 0 },
    { name: "REJECTED",         value: autonomy?.rejected       ?? 0 },
  ].filter((d) => d.value > 0);

  /* MTTR by strategy — bar chart + paginated table */
  const strategies: any[] = metrics?.mttrByStrategy ?? [];
  const totalPages = Math.ceil(strategies.length / PAGE_SIZE);
  const pageSlice  = strategies.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const barData = strategies.map((s: any) => ({
    name: s.strategyName,
    avg:  +(toMin(s.mttrAvgSeconds) ?? 0).toFixed(2),
    min:  +(toMin(s.mttrMinSeconds) ?? 0).toFixed(2),
    max:  +(toMin(s.mttrMaxSeconds) ?? 0).toFixed(2),
    count: s.incidentCount,
  }));

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <BarChart2 className="mr-2 h-5 w-5 text-primary" />
          Impact & Cost Analysis
        </h1>
      </div>

      {/* ── KPI cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center text-sm">
              <Clock className="w-4 h-4 mr-2" /> Agent MTTR
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl lg:text-3xl font-mono font-bold text-cyan-400 truncate">
              {animMttr.toFixed(1)}m
            </div>
            <div className="text-xs text-muted-foreground mt-1 truncate">
              vs {formatMin(toMin(mttr?.humanBaselineSeconds))} human baseline
            </div>
            {(mttr as any)?.outlierCount > 0 && (
              <div className="text-xs text-yellow-500/70 mt-1">
                {(mttr as any).outlierCount} stuck excluded
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center text-sm">
              <TrendingDown className="w-4 h-4 mr-2" /> MTTR Reduction
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl lg:text-3xl font-mono font-bold text-green-400">
              {animReduc.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground mt-1">Faster resolution time</div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center text-sm">
              <DollarSign className="w-4 h-4 mr-2" /> Cost Saved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl lg:text-3xl font-mono font-bold text-primary truncate">
              ${animSaved.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              vs {formatUsd(cost?.humanTotalCostIfManual)} manual
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground flex items-center text-sm">
              <BarChart2 className="w-4 h-4 mr-2" /> Resolution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl lg:text-3xl font-mono font-bold text-foreground">
              {Math.round(animResolved)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              of {metrics?.totalIncidents ?? 0} total incidents
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ── Routing Distribution (Pie) ─────────────────────────────── */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle>Routing Distribution</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={88}
                    paddingAngle={3}
                    dataKey="value"
                    animationBegin={100}
                    animationDuration={700}
                    animationEasing="ease-out"
                  >
                    {pieData.map((entry) => (
                      <Cell
                        key={entry.name}
                        fill={PIE_COLORS[entry.name] ?? "#6b7280"}
                        stroke="transparent"
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<DarkTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-xs font-mono">
                No data yet
              </div>
            )}
            {/* legend */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-2 font-mono text-xs">
              {[
                { label: "AUTONOMOUS",       color: "#4ade80", value: autonomy?.autonomous },
                { label: "PENDING_APPROVAL", color: "#facc15", value: autonomy?.pendingApproval },
                { label: "EXPLORATORY",      color: "#60a5fa", value: autonomy?.exploratory },
                { label: "REJECTED",         color: "#f87171", value: autonomy?.rejected },
              ].map(({ label, color, value }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                  <span className="text-muted-foreground truncate">{label}</span>
                  <span className="ml-auto text-foreground font-semibold">{value ?? 0}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ── Cost Breakdown ─────────────────────────────────────────── */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle>Cost Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-3 font-mono text-sm">
            {[
              { label: "Agent cost (est.)",  value: formatUsd(cost?.estimatedAgentCostUsd),  color: "text-primary"          },
              { label: "Manual baseline",    value: formatUsd(cost?.humanTotalCostIfManual), color: "text-muted-foreground" },
              { label: "Savings",            value: formatUsd(cost?.estimatedSavingsUsd),    color: "text-green-400"        },
              { label: "RU consumed",        value: cost?.totalRuConsumed != null ? cost.totalRuConsumed.toLocaleString() : "—", color: "text-cyan-400" },
              { label: "Avg RU / incident",  value: cost?.avgRuPerIncident != null ? cost.avgRuPerIncident.toFixed(1) : "—",    color: "text-foreground" },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex justify-between items-center border-b border-border/30 pb-2 last:border-0 last:pb-0">
                <span className="text-muted-foreground">{label}</span>
                <span className={`font-bold ${color}`}>{value}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* ── MTTR by Strategy ──────────────────────────────────────────── */}
      {strategies.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle>MTTR by Strategy</CardTitle>
            <p className="text-xs text-muted-foreground mt-1 leading-snug">
              Incidents &gt;30 min excluded (stuck incidents).
            </p>
          </CardHeader>
          <CardContent className="p-4 space-y-5">
            {/* bar chart — capped height, scrollable when many strategies */}
            <div className="overflow-y-auto" style={{ maxHeight: 300 }}>
              <ResponsiveContainer width="100%" height={Math.max(160, barData.length * 40)}>
                <BarChart
                  data={barData}
                  layout="vertical"
                  margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                  barSize={10}
                >
                  <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.4} strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontFamily: "monospace" }}
                    tickFormatter={(v) => `${v}m`}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={140}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontFamily: "monospace" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    content={<DarkTooltip formatter={(v: number) => `${v.toFixed(2)}m`} />}
                    cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.3 }}
                  />
                  <Bar
                    dataKey="min"
                    name="Min"
                    fill="#60a5fa"
                    radius={[0, 3, 3, 0]}
                    animationBegin={100}
                    animationDuration={600}
                    animationEasing="ease-out"
                  />
                  <Bar
                    dataKey="avg"
                    name="Avg"
                    fill="#22d3ee"
                    radius={[0, 3, 3, 0]}
                    animationBegin={200}
                    animationDuration={700}
                    animationEasing="ease-out"
                  />
                  <Bar
                    dataKey="max"
                    name="Max"
                    fill="#818cf8"
                    radius={[0, 3, 3, 0]}
                    animationBegin={300}
                    animationDuration={800}
                    animationEasing="ease-out"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* legend */}
            <div className="flex items-center gap-5 font-mono text-xs text-muted-foreground">
              {[
                { label: "Min", color: "#60a5fa" },
                { label: "Avg", color: "#22d3ee" },
                { label: "Max", color: "#818cf8" },
              ].map(({ label, color }) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
                  {label}
                </span>
              ))}
            </div>

            {/* paginated table */}
            <div className="overflow-x-auto rounded-md border border-border/40">
              <table className="w-full font-mono text-xs min-w-[500px]">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-left bg-muted/20">
                    <th className="px-4 py-2.5 font-medium">Strategy</th>
                    <th className="px-4 py-2.5 font-medium text-right">Count</th>
                    <th className="px-4 py-2.5 font-medium text-right">Avg MTTR</th>
                    <th className="px-4 py-2.5 font-medium text-right">Min</th>
                    <th className="px-4 py-2.5 font-medium text-right">Max</th>
                  </tr>
                </thead>
                <tbody>
                  {pageSlice.map((s: any, i: number) => (
                    <tr
                      key={page * PAGE_SIZE + i}
                      className="border-b border-border/30 hover:bg-muted/20 transition-colors duration-150"
                      style={{ animationDelay: `${i * 40}ms` }}
                    >
                      <td className="px-4 py-2.5 text-cyan-400">{s.strategyName}</td>
                      <td className="px-4 py-2.5 text-right text-foreground">{s.incidentCount}</td>
                      <td className="px-4 py-2.5 text-right text-foreground">{formatMin(toMin(s.mttrAvgSeconds))}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{formatMin(toMin(s.mttrMinSeconds))}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{formatMin(toMin(s.mttrMaxSeconds))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between font-mono text-xs text-muted-foreground pt-1">
                <span>
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, strategies.length)} of {strategies.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="flex items-center gap-0.5 px-2 py-1 rounded border border-border/50 hover:bg-muted/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-150"
                  >
                    <ChevronLeft className="w-3 h-3" /> Prev
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => (
                    <button
                      key={i}
                      onClick={() => setPage(i)}
                      className={`w-6 h-6 rounded border text-[10px] transition-colors duration-150 ${
                        i === page
                          ? "border-cyan-500 text-cyan-400 bg-cyan-500/10"
                          : "border-border/50 hover:bg-muted/40"
                      }`}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page === totalPages - 1}
                    className="flex items-center gap-0.5 px-2 py-1 rounded border border-border/50 hover:bg-muted/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-150"
                  >
                    Next <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
