import { useState } from "react";
import { useListIncidents, useApproveIncident, useRejectIncident, useCorrectIncident, getListIncidentsQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
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

export default function Incidents() {
  const queryClient = useQueryClient();
  const { data: incidents, isLoading } = useListIncidents({ query: { refetchInterval: 5000 } });
  
  const approve = useApproveIncident();
  const reject = useRejectIncident();
  const correct = useCorrectIncident();

  const [correctionStrategy, setCorrectionStrategy] = useState<Record<string, string>>({});

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

  return (
    <div className="max-w-[1400px] mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-mono font-bold tracking-tighter uppercase text-foreground flex items-center">
          <List className="mr-2 h-5 w-5 text-primary" />
          All Incidents
        </h1>
      </div>

      {pendingIncidents.length > 0 && (
        <Card className="border-yellow-500/50 shadow-[0_0_20px_rgba(234,179,8,0.15)] bg-yellow-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-yellow-500 flex items-center">
              <Badge variant="pending_approval" className="mr-3">ACTION REQUIRED</Badge> 
              Pending Approvals ({pendingIncidents.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {pendingIncidents.map(inc => (
              <div key={inc.incidentId} className="border border-yellow-500/30 bg-background p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 font-mono text-sm">
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{inc.incidentId.split("-")[0]}</span>
                    <span className="text-foreground font-bold">{inc.alertFingerprint}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Proposed: <span className="text-cyan-400">{inc.contextJson?.strategyName || "None"}</span> 
                    &nbsp;(WR: {inc.contextJson?.winRate ? (inc.contextJson.winRate * 100).toFixed(1) + "%" : "N/A"})
                  </div>
                </div>
                
                <div className="flex items-center gap-2 shrink-0">
                  <Select 
                    className="w-48 text-xs h-8 border-yellow-500/30"
                    value={correctionStrategy[inc.incidentId] || ""}
                    onChange={(e) => setCorrectionStrategy(prev => ({ ...prev, [inc.incidentId]: e.target.value }))}
                  >
                    <option value="">Correct Strategy...</option>
                    {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
                  </Select>
                  {correctionStrategy[inc.incidentId] ? (
                    <Button size="sm" variant="default" className="h-8" onClick={() => handleCorrect(inc.incidentId)}>
                      Apply
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" className="h-8 border-green-500/50 text-green-500 hover:bg-green-500/10" onClick={() => handleApprove(inc.incidentId)}>
                        <Check className="w-4 h-4 mr-1"/> Approve
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 border-red-500/50 text-red-500 hover:bg-red-500/10" onClick={() => handleReject(inc.incidentId)}>
                        <X className="w-4 h-4 mr-1"/> Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[100px]">ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Fingerprint</TableHead>
              <TableHead>Routing</TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
            ) : !incidents || incidents.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No incidents found</TableCell></TableRow>
            ) : (
              incidents.map((inc) => (
                <TableRow key={inc.incidentId}>
                  <TableCell className="text-muted-foreground font-mono text-xs">{inc.incidentId.split("-")[0]}</TableCell>
                  <TableCell>
                    <Badge variant={inc.status.toLowerCase() as any}>{inc.status}</Badge>
                  </TableCell>
                  <TableCell className="font-medium truncate max-w-[200px]" title={inc.alertFingerprint}>
                    {inc.alertFingerprint}
                  </TableCell>
                  <TableCell>
                    <Badge variant={inc.contextJson?.routingMode?.toLowerCase() as any || "outline"}>
                      {inc.contextJson?.routingMode || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-cyan-400 text-xs max-w-[150px] truncate" title={inc.contextJson?.strategyName}>
                    {inc.contextJson?.strategyName || "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(inc.updatedAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
