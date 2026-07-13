import { useGetCalibration, useRecalibrate, getGetCalibrationQueryKey, getGetWinRatesQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert, RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

export default function Calibration() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: calibration, isLoading } = useGetCalibration();
  const recalibrate = useRecalibrate();

  const handleRecalibrate = () => {
    recalibrate.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getGetCalibrationQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetWinRatesQueryKey() });
        toast({
          title: "Recalibration Complete",
          description: res.message || `Updated ${res.recalibrated} strategies.`,
        });
      }
    });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <ShieldAlert className="mr-2 h-5 w-5 text-primary" />
          Model Calibration
        </h1>
        <Button 
          variant="outline" 
          onClick={handleRecalibrate} 
          disabled={recalibrate.isPending}
          className="border-primary/50 text-primary hover:bg-primary/10"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${recalibrate.isPending ? "animate-spin" : ""}`} />
          Run Recalibration Job
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Strategy</TableHead>
                <TableHead className="text-right">Predicted</TableHead>
                <TableHead className="text-right">Observed</TableHead>
                <TableHead className="text-right">Correction</TableHead>
                <TableHead className="text-right">Sample</TableHead>
                <TableHead className="text-right">Last Calibrated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : !calibration || calibration.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">No calibration data available</TableCell></TableRow>
              ) : (
                calibration.map((cal, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs text-cyan-400">{cal.strategyName}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {cal.predictedWinRate ? (cal.predictedWinRate * 100).toFixed(1) + "%" : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-bold text-foreground">
                      {cal.observedWinRate ? (cal.observedWinRate * 100).toFixed(1) + "%" : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {cal.correctionFactor ? (
                        <span className={cal.correctionFactor > 1 ? "text-green-400" : cal.correctionFactor < 1 ? "text-red-400" : "text-muted-foreground"}>
                          {cal.correctionFactor.toFixed(2)}x
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">{cal.sampleSize}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {formatDate(cal.calibratedAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
