import { ReactNode, useState } from "react";
import { LeftNav } from "./LeftNav";
import { Sidebar } from "./Sidebar";
import { Menu, SlidersHorizontal } from "lucide-react";
import { Logo } from "@/components/brand";

const LS_LEFT_COLLAPSED  = "cs-left-collapsed";
const LS_RIGHT_COLLAPSED = "cs-right-collapsed";

function readBool(key: string, fallback = false): boolean {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === "true"; }
  catch { return fallback; }
}

export function Shell({ children }: { children: ReactNode }) {
  const [leftOpen,  setLeftOpen]  = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftCollapsed,  setLeftCollapsed]  = useState(() => readBool(LS_LEFT_COLLAPSED));
  const [rightCollapsed, setRightCollapsed] = useState(() => readBool(LS_RIGHT_COLLAPSED));

  function toggleLeft() {
    setLeftCollapsed(v => {
      const next = !v;
      try { localStorage.setItem(LS_LEFT_COLLAPSED, String(next)); } catch {}
      return next;
    });
  }

  function toggleRight() {
    setRightCollapsed(v => {
      const next = !v;
      try { localStorage.setItem(LS_RIGHT_COLLAPSED, String(next)); } catch {}
      return next;
    });
  }

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground
                    selection:bg-primary/15 selection:text-primary">

      {/* Mobile backdrop — left */}
      {leftOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={() => setLeftOpen(false)}
        />
      )}
      {/* Mobile backdrop — right */}
      {rightOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={() => setRightOpen(false)}
        />
      )}

      {/* LEFT — vertical navigation (always dark navy) */}
      <LeftNav
        open={leftOpen}
        onClose={() => setLeftOpen(false)}
        collapsed={leftCollapsed}
        onToggleCollapse={toggleLeft}
      />

      {/* CENTER — main content */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">

        {/* Mobile top bar — light surface matching page background */}
        <div className="md:hidden flex items-center justify-between h-12 px-3
                        border-b border-border bg-card shrink-0
                        shadow-[0_1px_3px_rgba(18,72,150,0.06)]">
          <button
            onClick={() => setLeftOpen(true)}
            className="flex items-center justify-center w-8 h-8 rounded-sm
                       text-muted-foreground hover:bg-muted hover:text-foreground
                       transition-colors"
            aria-label="Open navigation"
          >
            <Menu className="w-4 h-4" />
          </button>

          {/* Logo centered on mobile bar — brand theme (blue on white) */}
          <Logo variant="horizontal" theme="brand" size="xs" />

          <button
            onClick={() => setRightOpen(true)}
            className="flex items-center justify-center w-8 h-8 rounded-sm
                       text-muted-foreground hover:bg-muted hover:text-foreground
                       transition-colors"
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
        onToggleCollapse={toggleRight}
      />
    </div>
  );
}
