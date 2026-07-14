import { useState } from "react";
import { useGetWinRates, useGetCcloudMetrics } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Zap, Database } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Paginator } from "@/components/ui/paginator";

const PAGE_SIZE = 10;

export default function StrategyMemory() {
  const { data: winRates } = useGetWinRates({ query: { refetchInterval: 5000 } });
  const { data: ccloud } = useGetCcloudMetrics({ action: "health" });
  const [page, setPage] = useState(1);

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
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <Zap className="mr-2 h-5 w-5 text-primary shrink-0" />
          Strategy Memory
        </h1>
        {allRates.length > 0 && (
          <span className="text-[11px] font-mono text-muted-foreground hidden sm:block">
            {allRates.length} stratégie{allRates.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

        <div className="md:col-span-2 space-y-0">
          <Card>
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle>Historical Win-Rates</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Strategy</TableHead>
                    <TableHead className="w-[200px]">Performance</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Success / Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allRates.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">No data available</TableCell></TableRow>
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
        </div>

        <div className="md:col-span-1">
          <Card className="border-primary/30">
            <CardHeader className="pb-3 border-b border-border/50 bg-primary/5">
              <CardTitle className="flex items-center text-primary">
                <Database className="w-4 h-4 mr-2" />
                CockroachDB Status
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 font-mono text-sm space-y-4">
              <div className="flex justify-between items-center pb-2 border-b border-border/50">
                <span className="text-muted-foreground">Connection</span>
                <span className="text-green-400">ACTIVE</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-border/50">
                <span className="text-muted-foreground">Vector Dimension</span>
                <span className="text-foreground">1536 (OpenAI)</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-border/50">
                <span className="text-muted-foreground">Stored Strategies</span>
                <span className="text-cyan-400">{allRates.length}</span>
              </div>
              {ccloud && Object.keys(ccloud).length > 0 && (
                <div className="mt-4 pt-4 border-t border-border/50">
                  <div className="text-xs text-muted-foreground uppercase mb-2">Cluster Metrics</div>
                  <pre className="text-[10px] text-muted-foreground bg-muted/20 p-2 overflow-x-auto rounded-sm">
                    {JSON.stringify(ccloud, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}
