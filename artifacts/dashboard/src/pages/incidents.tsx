import { useState } from "react";
import { useListIncidents, useApproveIncident, useRejectIncident, useCorrectIncident, getListIncidentsQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Paginator } from "@/components/ui/paginator";
import { useQueryClient } from "@tanstack/react-query";
import { List, Check, X } from "lucide-react";
import { formatDate } from "@/lib/utils";

const STRATEGIES = [
  "Restart ECS Tasks",
  "Scale Read Replicas",
  "Increase Lambda Concurrency",
  "Clear /tmp space",
  "Restart JVM",
  "Kill Long Queries",
  "Failover Region"
];

const PAGE_SIZE = 10;

export default function Incidents() {
  const queryClient = useQueryClient();
  const { data: incidents, isLoading } = useListIncidents({ query: { refetchInterval: 5000 } });

  const approve = useApproveIncident();
  const reject = useRejectIncident();
  const correct = useCorrectIncident();

  const [correctionStrategy, setCorrectionStrategy] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);

  const handleApprove = (id: string) => {
    approve.mutate({ incidentId: id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListIncidentsQueryKey() })
    });
  };

  const handleReject = (id: string) => {
    reject.mutate({ incidentId: id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListIncidentsQueryKey() })
    });
  };

  const handleCorrect = (id: string) => {
    const strat = correctionStrategy[id];
    if (!strat) return;
    correct.mutate({ incidentId: id, data: { suggestedStrategy: strat } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListIncidentsQueryKey() });
        setCorrectionStrategy(prev => ({ ...prev, [id]: "" }));
      }
    });
  };

  const pendingIncidents = incidents?.filter(i => i.status === "PENDING_APPROVAL") || [];
  const allIncidents = incidents || [];
  const totalPages = Math.ceil(allIncidents.length / PAGE_SIZE);
  const paginated = allIncidents.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="w-full max-w-[1400px] mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-xl sm:text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <List className="mr-2 h-5 w-5 text-primary shrink-0" />
          All Incidents
        </h1>
        {allIncidents.length > 0 && (
          <span className="text-[11px] font-mono text-muted-foreground hidden sm:block">
            {allIncidents.length} incident{allIncidents.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Pending approvals — always shown in full, never paginated */}
      {pendingIncidents.length > 0 && (
        <Card className="border-yellow-500/50 shadow-[0_0_20px_rgba(234,179,8,0.15)] bg-yellow-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-yellow-500 flex items-center flex-wrap gap-2">
              <Badge variant="pending_approval">ACTION REQUIRED</Badge>
              Pending Approvals ({pendingIncidents.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {pendingIncidents.map(inc => (
              <div
                key={inc.incidentId}
                className="border border-yellow-500/30 bg-background p-4 flex flex-col gap-4 font-mono text-sm"
              >
                <div className="space-y-1 min-w-0">
                  {/* ID row */}
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground shrink-0 text-xs">{inc.incidentId.split("-")[0]}</span>
                    <span className="text-muted-foreground/50 text-xs shrink-0">·</span>
                    <span className="text-foreground/60 text-[10px] font-mono truncate min-w-0" title={inc.alertFingerprint}>
                      {inc.alertFingerprint}
                    </span>
                  </div>
                  {/* Proposed strategy */}
                  <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1 gap-y-0.5">
                    <span>Proposed:</span>
                    <span className="text-cyan-400 break-all">{inc.contextJson?.strategyName || "None"}</span>
                    <span className="shrink-0">
                      (WR: {inc.contextJson?.winRate != null ? (Number(inc.contextJson.winRate) * 100).toFixed(1) + "%" : "N/A"})
                    </span>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <Select
                    className="w-full sm:w-48 text-xs h-8 border-yellow-500/30"
                    value={correctionStrategy[inc.incidentId] || ""}
                    onChange={(e) => setCorrectionStrategy(prev => ({ ...prev, [inc.incidentId]: e.target.value }))}
                  >
                    <option value="">Correct Strategy...</option>
                    {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
                  </Select>
                  {correctionStrategy[inc.incidentId] ? (
                    <Button size="sm" variant="default" className="h-8 w-full sm:w-auto" onClick={() => handleCorrect(inc.incidentId)}>
                      Apply
                    </Button>
                  ) : (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="h-8 flex-1 sm:flex-none border-green-500/50 text-green-500 hover:bg-green-500/10" onClick={() => handleApprove(inc.incidentId)}>
                        <Check className="w-4 h-4 mr-1" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 flex-1 sm:flex-none border-red-500/50 text-red-500 hover:bg-red-500/10" onClick={() => handleReject(inc.incidentId)}>
                        <X className="w-4 h-4 mr-1" /> Reject
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Paginated incidents table */}
      <div className="border border-border bg-card rounded-sm overflow-x-auto">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[90px]">ID</TableHead>
              <TableHead className="w-[130px]">Status</TableHead>
              <TableHead>Fingerprint</TableHead>
              <TableHead className="w-[110px]">Routing</TableHead>
              <TableHead className="w-[160px]">Strategy</TableHead>
              <TableHead className="text-right w-[150px]">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
            ) : paginated.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No incidents found</TableCell></TableRow>
            ) : (
              paginated.map((inc) => (
                <TableRow key={inc.incidentId} className="cursor-pointer hover:bg-muted/40 transition-colors">
                  <TableCell className="text-muted-foreground font-mono text-xs">{inc.incidentId.split("-")[0]}</TableCell>
                  <TableCell>
                    <Badge variant={inc.status.toLowerCase() as any}>{inc.status}</Badge>
                  </TableCell>
                  <TableCell className="font-medium min-w-0">
                    <span className="block truncate max-w-[260px]" title={inc.alertFingerprint}>
                      {inc.alertFingerprint}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={inc.contextJson?.routingMode?.toLowerCase() as any || "outline"}>
                      {inc.contextJson?.routingMode || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-cyan-400 text-xs">
                    <span className="block truncate max-w-[160px]" title={inc.contextJson?.strategyName}>
                      {inc.contextJson?.strategyName || "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(inc.updatedAt)}
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
            totalItems={allIncidents.length}
            pageSize={PAGE_SIZE}
            onPage={setPage}
          />
        </div>
      </div>
    </div>
  );
}
