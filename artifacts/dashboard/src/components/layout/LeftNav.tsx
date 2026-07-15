import { Link, useLocation } from "wouter";
import { Activity, Zap, GitCommit, List, BarChart2, ShieldAlert, BookOpen, Terminal, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand";

const navItems = [
  { href: "/",            label: "Guide",           icon: BookOpen  },
  { href: "/live",        label: "Live Diagnostic",  icon: Activity  },
  { href: "/decision",    label: "Decision Trace",   icon: GitCommit },
  { href: "/incidents",   label: "All Incidents",    icon: List      },
  { href: "/memory",      label: "Strategy Memory",  icon: Zap       },
  { href: "/calibration", label: "Calibration",      icon: ShieldAlert },
  { href: "/impact",      label: "Impact & Cost",    icon: BarChart2 },
  { href: "/logs",        label: "Agent Logs",       icon: Terminal  },
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
        /* Always dark-navy surface regardless of page theme */
        "flex-shrink-0 bg-sidebar flex flex-col h-full z-50 overflow-hidden",
        "border-r border-sidebar-border",
        /* Width transition — desktop only */
        "md:transition-[width] md:duration-200 md:ease-in-out",
        collapsed ? "md:w-12" : "md:w-54",
        /* Mobile: full-width overlay */
        "w-54",
        "fixed top-0 left-0 transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "-translate-x-full",
        "md:static md:translate-x-0 md:transition-[width]"
      )}
    >
      {/* ── Brand header ─────────────────────────────────────────────────── */}
      <div className={cn(
        "h-14 flex items-center border-b border-sidebar-border shrink-0",
        collapsed ? "px-0 justify-center" : "px-4 justify-between"
      )}>
        {collapsed ? (
          /* Icon-only mark when collapsed */
          <Logo variant="mark" theme="white" size="sm" aria-label="Cloud-Surgeon" />
        ) : (
          <>
            <Logo variant="horizontal" theme="white" size="sm" aria-label="Cloud-Surgeon" />
            {/* Mobile close */}
            <button
              onClick={onClose}
              className="md:hidden w-6 h-6 flex items-center justify-center rounded-sm
                         text-sidebar-foreground/50 hover:text-sidebar-foreground
                         hover:bg-white/10 transition-colors shrink-0"
              aria-label="Close navigation"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* ── API status indicator ──────────────────────────────────────────── */}
      <div className={cn(
        "border-b border-sidebar-border/50 flex items-center",
        collapsed ? "py-3 justify-center" : "px-4 py-2.5"
      )}>
        <span className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          health ? "bg-emerald-400" : "bg-red-400"
        )} />
        {!collapsed && (
          <span className={cn(
            "ml-2 text-[10px] font-mono uppercase tracking-widest",
            health ? "text-emerald-400" : "text-red-400"
          )}>
            {health ? "API Online" : "Offline"}
          </span>
        )}
      </div>

      {/* ── Nav items ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto py-2">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href} onClick={onClose}>
              <div
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex items-center py-2.5 cursor-pointer transition-all select-none",
                  collapsed
                    ? "mx-1 px-2 justify-center rounded-sm"
                    : "mx-2 px-3 gap-3 rounded-sm border-l-2",
                  isActive
                    ? "bg-white/10 text-white border-white/70"
                    : collapsed
                      ? "text-sidebar-foreground/55 hover:text-sidebar-foreground hover:bg-white/8"
                      : "text-sidebar-foreground/55 hover:text-sidebar-foreground hover:bg-white/8 border-transparent"
                )}
              >
                <item.icon className={cn(
                  "w-4 h-4 shrink-0",
                  isActive ? "text-white" : "text-sidebar-foreground/55"
                )} />
                {!collapsed && (
                  <span className={cn(
                    "text-xs font-mono uppercase tracking-tight truncate",
                    isActive ? "text-white font-semibold" : "text-sidebar-foreground/70"
                  )}>
                    {item.label}
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div className={cn(
        "border-t border-sidebar-border/50 flex items-center",
        collapsed ? "py-3 justify-center" : "px-4 py-3 justify-between"
      )}>
        {!collapsed && (
          <p className="text-[9px] font-mono text-sidebar-foreground/30 uppercase tracking-widest truncate">
            CockroachDB × AWS 2026
          </p>
        )}
        {/* Desktop-only collapse button */}
        <button
          onClick={onToggleCollapse}
          className="hidden md:flex items-center justify-center w-6 h-6 rounded-sm
                     text-sidebar-foreground/40 hover:text-sidebar-foreground
                     hover:bg-white/10 transition-colors shrink-0"
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {collapsed
            ? <ChevronRight className="w-3.5 h-3.5" />
            : <ChevronLeft  className="w-3.5 h-3.5" />
          }
        </button>
      </div>
    </nav>
  );
}
