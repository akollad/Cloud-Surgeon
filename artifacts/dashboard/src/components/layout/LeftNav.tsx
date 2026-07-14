import { Link, useLocation } from "wouter";
import { Activity, Zap, GitCommit, List, BarChart2, ShieldAlert, BookOpen, Terminal, X, ChevronLeft, ChevronRight } from "lucide-react";
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
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function LeftNav({ open, onClose, collapsed, onToggleCollapse }: LeftNavProps) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck(undefined, { query: { refetchInterval: 5000 } });

  return (
    <nav
      className={cn(
        "flex-shrink-0 border-r border-border bg-card flex flex-col h-full z-50 overflow-hidden",
        // Width transition — desktop only
        "md:transition-[width] md:duration-200 md:ease-in-out",
        collapsed ? "md:w-12" : "md:w-52",
        // Mobile: always full width as overlay
        "w-52",
        // Mobile slide
        "fixed top-0 left-0 transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "-translate-x-full",
        "md:static md:translate-x-0 md:transition-[width]"
      )}
    >
      {/* Header */}
      <div className={cn(
        "h-14 flex items-center border-b border-border shrink-0",
        collapsed ? "px-0 justify-center" : "px-4 justify-between"
      )}>
        {collapsed ? (
          <Terminal className="w-4 h-4 text-primary" />
        ) : (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <Terminal className="w-4 h-4 text-primary shrink-0" />
              <span className="font-mono font-bold text-sm tracking-tighter uppercase text-foreground truncate">
                Cloud-Surgeon
              </span>
            </div>
            {/* Mobile close */}
            <button
              onClick={onClose}
              className="md:hidden w-6 h-6 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              aria-label="Close nav"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Status indicator */}
      <div className={cn(
        "border-b border-border/50 flex items-center",
        collapsed ? "py-3 justify-center" : "px-4 py-2.5"
      )}>
        <span className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          health ? "bg-green-500" : "bg-red-500"
        )} />
        {!collapsed && (
          <span className={cn(
            "ml-2 text-[10px] font-mono uppercase tracking-wider",
            health ? "text-green-500" : "text-red-500"
          )}>
            {health ? "API Online" : "Offline"}
          </span>
        )}
      </div>

      {/* Nav items */}
      <div className="flex-1 overflow-y-auto py-2">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href} onClick={onClose}>
              <div
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex items-center py-2.5 cursor-pointer transition-colors select-none",
                  collapsed
                    ? "mx-1 px-2 justify-center rounded-sm border-l-0"
                    : "mx-2 px-3 gap-3 rounded-sm border-l-2",
                  isActive
                    ? collapsed
                      ? "bg-primary/10 text-primary"
                      : "bg-primary/10 text-primary border-primary"
                    : collapsed
                      ? "text-muted-foreground hover:text-foreground hover:bg-muted"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted border-transparent"
                )}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {!collapsed && (
                  <span className="text-xs font-mono uppercase tracking-tight truncate">
                    {item.label}
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {/* Footer / collapse toggle */}
      <div className={cn(
        "border-t border-border/50 flex items-center",
        collapsed ? "py-3 justify-center" : "px-4 py-3 justify-between"
      )}>
        {!collapsed && (
          <p className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest truncate">
            CockroachDB × AWS 2026
          </p>
        )}
        {/* Desktop-only collapse button */}
        <button
          onClick={onToggleCollapse}
          className="hidden md:flex items-center justify-center w-6 h-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
        </button>
      </div>
    </nav>
  );
}
