import { useState } from "react";
import { useGetCalibration, useRecalibrate, getGetCalibrationQueryKey, getGetWinRatesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert, RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Paginator } from "@/components/ui/paginator";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const PAGE_SIZE = 10;

export default function Calibration() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: calibration, isLoading } = useGetCalibration();
  const recalibrate = useRecalibrate();
  const [page, setPage] = useState(1);

  const handleRecalibrate = () => {
    recalibrate.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getGetCalibrationQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetWinRatesQueryKey() });
        setPage(1);
        toast({
          title: "Recalibration Complete",
          description: res.message || `Updated ${res.recalibrated} strategies.`,
        });
      }
    });
  };

  const allRows = calibration || [];
  const totalPages = Math.ceil(allRows.length / PAGE_SIZE);
  const paginated = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-border pb-4 gap-3">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <ShieldAlert className="mr-2 h-5 w-5 text-primary shrink-0" />
          Model Calibration
        </h1>
        <Button
          variant="outline"
          onClick={handleRecalibrate}
          disabled={recalibrate.isPending}
          className="border-primary/50 text-primary hover:bg-primary/10 shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${recalibrate.isPending ? "animate-spin" : ""} sm:mr-2`} />
          <span className="hidden sm:inline">Run Recalibration Job</span>
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[480px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Predicted</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Observed</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Correction</TableHead>
                  <TableHead className="text-right whitespace-nowrap">N</TableHead>
                  <TableHead className="text-right whitespace-nowrap hidden sm:table-cell">Last Calibrated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">Loading...</TableCell></TableRow>
                ) : paginated.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">No calibration data available</TableCell></TableRow>
                ) : (
                  paginated.map((cal, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs text-cyan-400">{cal.strategyName}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {cal.avgPredictedWinRate != null ? (cal.avgPredictedWinRate * 100).toFixed(1) + "%" : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs font-bold text-foreground">
                        {cal.observedWinRate != null ? (cal.observedWinRate * 100).toFixed(1) + "%" : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {cal.correctionFactor != null ? (
                          <span className={cal.correctionFactor > 1 ? "text-green-400" : cal.correctionFactor < 1 ? "text-red-400" : "text-muted-foreground"}>
                            {cal.correctionFactor.toFixed(2)}x
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">{cal.predictionCount ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground whitespace-nowrap hidden sm:table-cell">
                        {formatDate(cal.lastRecalculatedAt)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="px-4 pb-3">
            <Paginator
              page={page}
              totalPages={totalPages}
              totalItems={allRows.length}
              pageSize={PAGE_SIZE}
              onPage={setPage}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
