import { Link, useLocation } from "wouter";
import { Activity, Zap, GitCommit, List, BarChart2, ShieldAlert, BookOpen, Terminal } from "lucide-react";
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

export function TopNav() {
  const [location] = useLocation();

  return (
    <div className="w-full border-b border-border bg-card overflow-x-auto flex items-center h-12 px-2 shrink-0">
      <div className="flex space-x-1">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex items-center space-x-2 px-3 py-1.5 text-xs font-mono uppercase tracking-tight rounded-sm transition-colors cursor-pointer select-none",
                  isActive 
                    ? "bg-primary/10 text-primary font-semibold" 
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <item.icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
