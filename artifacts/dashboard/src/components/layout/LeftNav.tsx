import { Link, useLocation } from "wouter";
import { Activity, Zap, GitCommit, List, BarChart2, ShieldAlert, BookOpen, Terminal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useHealthCheck } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Guide", icon: BookOpen },
  { href: "/live", label: "Live Diagnostic", icon: Activity },
  { href: "/decision", label: "Decision Trace", icon: GitCommit },
  { href: "/incidents", label: "All Incidents", icon: List },
  { href: "/memory", label: "Strategy Memory", icon: Zap },
  { href: "/calibration", label: "Calibration", icon: ShieldAlert },
  { href: "/impact", label: "Impact & Cost", icon: BarChart2 },
  { href: "/logs", label: "Agent Logs", icon: Terminal },
];

interface LeftNavProps {
  open: boolean;
  onClose: () => void;
}

export function LeftNav({ open, onClose }: LeftNavProps) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck(undefined, { query: { refetchInterval: 5000 } });

  return (
    <nav
      className={cn(
        "w-52 flex-shrink-0 border-r border-border bg-card flex flex-col h-full z-50",
        // Mobile: fixed overlay from the left
        "fixed top-0 left-0 transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "-translate-x-full",
        // Desktop: always in flow
        "md:static md:translate-x-0 md:transition-none"
      )}
    >
      {/* Brand header */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-4 h-4 text-primary shrink-0" />
          <span className="font-mono font-bold text-sm tracking-tighter uppercase text-foreground truncate">
            Cloud-Surgeon
          </span>
        </div>
        <button
          onClick={onClose}
          className="md:hidden w-6 h-6 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          aria-label="Close nav"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Status badge */}
      <div className="px-4 py-3 border-b border-border/50">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] font-mono w-full justify-center",
            health
              ? "text-green-500 border-green-500/30 bg-green-500/5"
              : "text-red-500 border-red-500/30 bg-red-500/5"
          )}
        >
          {health ? "● API ONLINE" : "○ OFFLINE"}
        </Badge>
      </div>

      {/* Nav items */}
      <div className="flex-1 overflow-y-auto py-2">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href} onClick={onClose}>
              <div
                className={cn(
                  "flex items-center gap-3 mx-2 px-3 py-2.5 rounded-sm cursor-pointer transition-colors select-none",
                  isActive
                    ? "bg-primary/10 text-primary border-l-2 border-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted border-l-2 border-transparent"
                )}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span className="text-xs font-mono uppercase tracking-tight truncate">
                  {item.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border/50">
        <p className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest">
          CockroachDB × AWS 2026
        </p>
      </div>
    </nav>
  );
}
