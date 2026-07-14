import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface PaginatorProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPage: (p: number) => void;
}

function getPages(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const seen = new Set<number>();
  const out: (number | "…")[] = [];

  const add = (p: number) => {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  };

  add(1);
  if (current > 3) out.push("…");
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) add(p);
  if (current < total - 2) out.push("…");
  add(total);

  return out;
}

export function Paginator({ page, totalPages, totalItems, pageSize, onPage }: PaginatorProps) {
  if (totalPages <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);
  const pages = getPages(page, totalPages);

  const btn = (disabled: boolean) =>
    cn(
      "h-7 w-7 flex items-center justify-center rounded-sm transition-colors",
      disabled
        ? "text-muted-foreground/25 cursor-not-allowed"
        : "text-muted-foreground hover:text-foreground hover:bg-muted"
    );

  return (
    <div className="flex items-center justify-between px-1 pt-3 border-t border-border/50">
      <span className="text-[11px] font-mono text-muted-foreground">
        {from}–{to} / {totalItems}
      </span>

      <div className="flex items-center gap-0.5">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page === 1}
          className={btn(page === 1)}
          aria-label="Page précédente"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>

        {pages.map((p, i) =>
          p === "…" ? (
            <span
              key={`el-${i}`}
              className="h-7 w-6 flex items-center justify-center text-[11px] font-mono text-muted-foreground/40"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p as number)}
              className={cn(
                "h-7 min-w-[1.75rem] px-1.5 flex items-center justify-center rounded-sm text-[11px] font-mono transition-colors",
                p === page
                  ? "bg-primary/10 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              {p}
            </button>
          )
        )}

        <button
          onClick={() => onPage(page + 1)}
          disabled={page === totalPages}
          className={btn(page === totalPages)}
          aria-label="Page suivante"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
