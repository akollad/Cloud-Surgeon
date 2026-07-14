import { ReactNode, useState } from "react";
import { LeftNav } from "./LeftNav";
import { Sidebar } from "./Sidebar";
import { Terminal, Menu, SlidersHorizontal } from "lucide-react";

export function Shell({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground selection:bg-primary selection:text-primary-foreground">

      {/* Mobile backdrops */}
      {leftOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setLeftOpen(false)} />
      )}
      {rightOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setRightOpen(false)} />
      )}

      {/* LEFT — vertical navigation */}
      <LeftNav
        open={leftOpen}
        onClose={() => setLeftOpen(false)}
        collapsed={leftCollapsed}
        onToggleCollapse={() => setLeftCollapsed(v => !v)}
      />

      {/* CENTER — main content */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">

        {/* Mobile top bar */}
        <div className="md:hidden flex items-center justify-between h-12 px-3 border-b border-border bg-card shrink-0">
          <button
            onClick={() => setLeftOpen(true)}
            className="flex items-center justify-center w-8 h-8 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Open navigation"
          >
            <Menu className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1.5">
            <Terminal className="w-4 h-4 text-primary" />
            <span className="font-mono font-bold text-sm tracking-tighter uppercase text-foreground">Cloud-Surgeon</span>
          </div>
          <button
            onClick={() => setRightOpen(true)}
            className="flex items-center justify-center w-8 h-8 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Open controls"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
        </div>

        <main className="flex-1 overflow-y-auto p-4 md:p-6 bg-background relative">
          {children}
        </main>
      </div>

      {/* RIGHT — control panel */}
      <Sidebar
        open={rightOpen}
        onClose={() => setRightOpen(false)}
        collapsed={rightCollapsed}
        onToggleCollapse={() => setRightCollapsed(v => !v)}
      />
    </div>
  );
}
