/**
 * Watches incident state changes and fires the appropriate sound.
 * Attach once at the app level — works across all pages.
 */
import { useEffect, useRef } from "react";
import { useListIncidents } from "@workspace/api-client-react";
import {
  playNewIncident,
  playPendingApproval,
  playResolved,
  playFailed,
  playPredictive,
} from "./use-sound";

const POLL_INTERVAL = 4000;

export function useSoundNotifications(muted: boolean) {
  // Map of incidentId → last known status
  const knownRef = useRef<Map<string, string>>(new Map());
  // Flag so we skip sounds on the very first load (avoid blasting on page open)
  const initializedRef = useRef(false);

  const { data: incidents } = useListIncidents({
    query: { refetchInterval: POLL_INTERVAL },
  });

  useEffect(() => {
    if (!incidents) return;

    if (!initializedRef.current) {
      // Seed the map silently on first load
      for (const inc of incidents) {
        knownRef.current.set(inc.incidentId, inc.status);
      }
      initializedRef.current = true;
      return;
    }

    if (muted) return;

    const known = knownRef.current;

    for (const inc of incidents) {
      const prev = known.get(inc.incidentId);

      if (prev === undefined) {
        // Brand-new incident
        if (inc.status === "PREDICTIVE") {
          playPredictive();
        } else {
          playNewIncident();
        }
      } else if (prev !== inc.status) {
        // Status transition
        switch (inc.status) {
          case "PENDING_APPROVAL":
            playPendingApproval();
            break;
          case "RESOLVED":
            playResolved();
            break;
          case "FAILED":
            playFailed();
            break;
          case "PREDICTIVE":
            playPredictive();
            break;
          default:
            break;
        }
      }

      known.set(inc.incidentId, inc.status);
    }
  }, [incidents, muted]);
}
