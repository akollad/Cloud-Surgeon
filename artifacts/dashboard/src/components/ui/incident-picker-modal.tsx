/**
 * IncidentPickerModal — composant réutilisable pour sélectionner un incident.
 *
 * Fonctionnalités :
 * - Overlay plein écran avec backdrop blur (style Decision Trace)
 * - Recherche par fingerprint, ID ou status
 * - Pagination côté client (8 incidents par page)
 * - Fermeture : bouton ×, touche Escape, clic en dehors
 * - Animation d'entrée / sortie fluide
 */

import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import { Search, X, CheckCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const PICKER_PAGE_SIZE = 8;

export interface PickerIncident {
  incidentId: string;
  alertFingerprint: string;
  status: string;
  updatedAt: string | null;
  triggeredAt?: string | null;
  createdAt?: string | null;
}

interface IncidentPickerModalProps {
  open: boolean;
  onClose: () => void;
  incidents: PickerIncident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  RESOLVED:         "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  FAILED:           "bg-red-500/15 text-red-400 border-red-500/30",
  PENDING_APPROVAL: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  TRIGGERED:        "bg-blue-500/15 text-blue-400 border-blue-500/30",
  DIAGNOSING:       "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  REPAIRING:        "bg-purple-500/15 text-purple-400 border-purple-500/30",
  PREDICTIVE:       "bg-violet-500/15 text-violet-400 border-violet-500/30",
};

function fmtDate(ts: string | null | undefined) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return "—"; }
}

export function IncidentPickerModal({
  open,
  onClose,
  incidents,
  selectedId,
  onSelect,
  loading,
}: IncidentPickerModalProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setSearch("");
      setPage(1);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const filtered = incidents.filter(i =>
    i.alertFingerprint.toLowerCase().includes(search.toLowerCase()) ||
    i.incidentId.toLowerCase().includes(search.toLowerCase()) ||
    i.status.toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PICKER_PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PICKER_PAGE_SIZE, page * PICKER_PAGE_SIZE);

  function handleSearchChange(v: string) {
    setSearch(v);
    setPage(1);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-card border border-border shadow-2xl rounded-sm animate-in zoom-in-95 fade-in duration-150 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/20">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={searchRef}
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search by fingerprint, ID or status…"
            className="flex-1 bg-transparent outline-none font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
          />
          {search && (
            <button
              onClick={() => handleSearchChange("")}
              className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 border border-transparent hover:border-border/50"
            aria-label="Close picker"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* List */}
        <div className="divide-y divide-border/30 max-h-[380px] overflow-y-auto">
          {loading ? (
            <div className="py-10 text-center font-mono text-xs text-muted-foreground">
              <span className="inline-block w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground/60 rounded-full animate-spin mb-2" />
              <div>Loading incidents…</div>
            </div>
          ) : paged.length === 0 ? (
            <div className="py-10 text-center font-mono text-xs text-muted-foreground">
              {search ? `No incidents matching "${search}"` : "No incidents found"}
            </div>
          ) : paged.map((inc, idx) => (
            <button
              key={inc.incidentId}
              onClick={() => { onSelect(inc.incidentId); onClose(); }}
              className={cn(
                "w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors animate-in fade-in duration-150",
                inc.incidentId === selectedId && "bg-primary/5 border-l-2 border-l-primary pl-3.5"
              )}
              style={{ animationDelay: `${idx * 15}ms` }}
            >
              {/* Status badge */}
              <span className={cn(
                "shrink-0 inline-flex items-center px-2 py-0.5 rounded-sm border font-mono text-[10px] uppercase tracking-wider mt-0.5",
                STATUS_COLORS[inc.status] ?? "bg-muted/40 text-muted-foreground border-border/50"
              )}>
                {inc.status}
              </span>
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-foreground truncate">{inc.alertFingerprint}</div>
                <div className="font-mono text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                  <span>{fmtDate(inc.updatedAt)}</span>
                  <span className="text-primary/60">#{inc.incidentId.slice(0, 8)}</span>
                </div>
              </div>
              {inc.incidentId === selectedId && (
                <CheckCircle className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
              )}
            </button>
          ))}
        </div>

        {/* Footer / pagination */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-muted/10">
          <span className="text-[10px] font-mono text-muted-foreground">
            {filtered.length} incident{filtered.length !== 1 ? "s" : ""}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="w-6 h-6 flex items-center justify-center rounded-sm border border-border text-muted-foreground disabled:opacity-30 hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
              <span className="px-2 text-[10px] font-mono text-muted-foreground tabular-nums">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="w-6 h-6 flex items-center justify-center rounded-sm border border-border text-muted-foreground disabled:opacity-30 hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Next page"
              >
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
