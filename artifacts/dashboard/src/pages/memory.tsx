import { useState } from "react";
import { useGetWinRates, useGetCcloudMetrics } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Zap, Database, X } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Paginator } from "@/components/ui/paginator";

const PAGE_SIZE = 10;

export default function StrategyMemory() {
  const { data: winRates } = useGetWinRates({ query: { refetchInterval: 5000 } });
  const { data: ccloud } = useGetCcloudMetrics({ action: "health" });
  const [page, setPage] = useState(1);
  const [dbOpen, setDbOpen] = useState(false);

  const getBarColor = (rate: number) => {
    if (rate >= 0.8) return "bg-green-500";
    if (rate >= 0.5) return "bg-yellow-500";
    return "bg-red-500";
  };

  const allRates = winRates || [];
  const totalPages = Math.ceil(allRates.length / PAGE_SIZE);
  const paginated = allRates.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <Zap className="mr-2 h-5 w-5 text-primary shrink-0" />
          Strategy Memory
        </h1>
        <div className="flex items-center gap-3">
          {allRates.length > 0 && (
            <span className="text-[11px] font-mono text-muted-foreground hidden sm:block">
              {allRates.length} stratégie{allRates.length !== 1 ? "s" : ""}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDbOpen(true)}
            className="border-primary/40 text-primary hover:bg-primary/10 font-mono text-xs gap-2"
          >
            <Database className="w-3.5 h-3.5" />
            CockroachDB
          </Button>
        </div>
      </div>

      {/* Win-rates table — full width now */}
      <Card>
        <CardHeader className="pb-3 border-b border-border/50">
          <CardTitle>Historical Win-Rates</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Strategy</TableHead>
                <TableHead className="w-[220px]">Performance</TableHead>
                <TableHead className="text-right whitespace-nowrap">Success / Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allRates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-6 text-muted-foreground">
                    No data available
                  </TableCell>
                </TableRow>
              ) : (
                paginated.map((wr, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs text-foreground">{wr.strategyName}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full ${getBarColor(wr.winRate)}`}
                            style={{ width: `${Math.max(wr.winRate * 100, 2)}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs text-muted-foreground w-10 text-right shrink-0">
                          {(wr.winRate * 100).toFixed(0)}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      <span className="text-foreground">{wr.successCount}</span> / {wr.totalCount}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="px-4 pb-3">
            <Paginator
              page={page}
              totalPages={totalPages}
              totalItems={allRates.length}
              pageSize={PAGE_SIZE}
              onPage={setPage}
            />
          </div>
        </CardContent>
      </Card>

      {/* CockroachDB modal */}
      {dbOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setDbOpen(false)}
        >
          <div
            className="w-full max-w-md bg-card border border-primary/30 shadow-[0_0_40px_rgba(0,255,255,0.15)] rounded-sm animate-in fade-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-primary/5">
              <div className="flex items-center gap-2 text-primary">
                <Database className="w-4 h-4" />
                <span className="font-mono font-bold text-sm uppercase tracking-wider">CockroachDB Status</span>
              </div>
              <button
                onClick={() => setDbOpen(false)}
                className="w-6 h-6 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Modal body */}
            <div className="p-5 font-mono text-sm space-y-3">
              <div className="flex justify-between items-center py-2 border-b border-border/40">
                <span className="text-muted-foreground">Connection</span>
                <span className="text-green-400 font-bold">ACTIVE</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border/40">
                <span className="text-muted-foreground">Vector Dimension</span>
                <span className="text-foreground">1536 (OpenAI)</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border/40">
                <span className="text-muted-foreground">Stored Strategies</span>
                <span className="text-cyan-400 font-bold">{allRates.length}</span>
              </div>

              {ccloud && Object.keys(ccloud).length > 0 && (
                <div className="pt-2">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
                    Cluster Metrics
                  </div>
                  <pre className="text-[11px] text-muted-foreground bg-black/40 border border-border/40 p-3 overflow-x-auto rounded-sm max-h-48 overflow-y-auto">
                    {JSON.stringify(ccloud, null, 2)}
                  </pre>
                </div>
              )}

              <div className="pt-2 text-[10px] text-muted-foreground/40 uppercase tracking-widest text-center">
                CockroachDB Serverless × AWS 2026
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
