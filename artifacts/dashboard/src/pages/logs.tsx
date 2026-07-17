import { useState, useEffect } from "react";
import { useListExecutionLogs } from "@workspace/api-client-react";
import { Terminal, RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Paginator } from "@/components/ui/paginator";
import { formatDate } from "@/lib/utils";

const PAGE_SIZE = 15;

export default function Logs() {
  const [filterId, setFilterId] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [debouncedFilter]);

  const { data: logs, isLoading, refetch, isRefetching } = useListExecutionLogs(
    { incidentId: debouncedFilter || undefined },
    { query: { keepPreviousData: true } }
  );

  const handleFilter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") setDebouncedFilter(filterId);
  };

  const allLogs = logs || [];
  const totalPages = Math.ceil(allLogs.length / PAGE_SIZE);
  const paginated = allLogs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500 pb-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-border pb-4 gap-3">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center shrink-0">
          <Terminal className="mr-2 h-5 w-5 text-primary shrink-0" />
          <span className="hidden sm:inline">Execution Logs</span>
          <span className="sm:hidden">Logs</span>
        </h1>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Input
            placeholder="Filter by ID… (Enter)"
            className="flex-1 sm:w-64 sm:flex-none min-w-0 text-xs sm:text-sm"
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
            onKeyDown={handleFilter}
          />
          <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isRefetching} className="shrink-0">
            <RefreshCw className={`w-4 h-4 ${isRefetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Table — no internal scroll; page naturally scrolls */}
      <div className="border border-border bg-card rounded-sm overflow-x-auto">
        <Table className="min-w-[700px] w-full">
          <TableHeader className="border-b border-border">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[150px] whitespace-nowrap">Timestamp</TableHead>
              <TableHead className="w-[100px] whitespace-nowrap">Incident ID</TableHead>
              <TableHead className="w-[200px] whitespace-nowrap">Action</TableHead>
              <TableHead>Result / Output</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground font-mono">Querying logs...</TableCell></TableRow>
            ) : paginated.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground font-mono">No logs found</TableCell></TableRow>
            ) : (
              paginated.map((log) => (
                <TableRow key={log.logId} className="border-b border-border/30 hover:bg-muted/20">
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap align-top pt-3">
                    {formatDate(log.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs text-primary font-bold align-top pt-3 font-mono">
                    {log.incidentId.split("-")[0]}
                  </TableCell>
                  <TableCell className="text-xs text-cyan-400 font-bold align-top pt-3 break-words max-w-[200px]">
                    {log.actionTaken}
                  </TableCell>
                  <TableCell className="text-[11px] text-muted-foreground font-mono pb-3">
                    <div className="bg-muted/30 p-2 border border-border/40 rounded-sm max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all">
                      {log.result || "—"}
                    </div>
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
            totalItems={allLogs.length}
            pageSize={PAGE_SIZE}
            onPage={setPage}
          />
        </div>
      </div>
    </div>
  );
}
