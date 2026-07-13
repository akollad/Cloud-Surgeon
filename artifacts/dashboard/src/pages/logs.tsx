import { useState } from "react";
import { useListExecutionLogs } from "@workspace/api-client-react";
import { Terminal, RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

export default function Logs() {
  const [filterId, setFilterId] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");

  const { data: logs, isLoading, refetch, isRefetching } = useListExecutionLogs(
    { incidentId: debouncedFilter || undefined },
    { query: { keepPreviousData: true } }
  );

  const handleFilter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      setDebouncedFilter(filterId);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500 h-full flex flex-col pb-6">
      <div className="flex items-center justify-between border-b border-border pb-4 shrink-0">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <Terminal className="mr-2 h-5 w-5 text-primary" />
          Execution Logs
        </h1>
        <div className="flex items-center gap-2">
          <Input 
            placeholder="Filter by Incident ID... (Enter)" 
            className="w-64"
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
            onKeyDown={handleFilter}
          />
          <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isRefetching}>
            <RefreshCw className={`w-4 h-4 ${isRefetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 border border-border bg-[#0a0a0a] rounded-sm overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1 p-0">
          <Table>
            <TableHeader className="sticky top-0 bg-[#0a0a0a] z-10 shadow-sm border-b border-border">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[180px]">Timestamp</TableHead>
                <TableHead className="w-[120px]">Incident ID</TableHead>
                <TableHead className="w-[200px]">Action</TableHead>
                <TableHead>Result / Output</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground font-mono">Querying logs...</TableCell></TableRow>
              ) : !logs || logs.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground font-mono">No logs found</TableCell></TableRow>
              ) : (
                logs.map((log) => (
                  <TableRow key={log.logId} className="border-b border-border/30 hover:bg-white/5">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap align-top pt-3">
                      {formatDate(log.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-primary font-bold align-top pt-3">
                      {log.incidentId.split("-")[0]}
                    </TableCell>
                    <TableCell className="text-xs text-cyan-400 font-bold align-top pt-3">
                      {log.actionTaken}
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground font-mono break-all pb-3">
                      <div className="bg-black/30 p-2 border border-white/5 rounded-sm max-h-[150px] overflow-y-auto whitespace-pre-wrap">
                        {log.result || "—"}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
