import { useEffect } from "react";
import { useLocation } from "wouter";
import { useListIncidents } from "@workspace/api-client-react";
import { GitBranch } from "lucide-react";

/**
 * /timeline — redirects to the most recent incident's timeline.
 * If no incidents exist yet, shows a waiting state.
 */
export default function TimelineLanding() {
  const { data: incidents, isLoading } = useListIncidents();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (incidents && incidents.length > 0) {
      navigate(`/incidents/${incidents[0].incidentId}`, { replace: true });
    }
  }, [incidents, navigate]);

  if (isLoading || (incidents && incidents.length > 0)) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-sm text-muted-foreground animate-pulse">
        LOADING TIMELINE…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 font-mono text-sm text-muted-foreground">
      <GitBranch className="h-6 w-6 opacity-40" />
      <p>No incidents yet — trigger one to see the timeline.</p>
    </div>
  );
}
