/**
 * PanelSelect — composant réutilisable pour les selects du panneau Controls.
 *
 * Le dropdown est rendu via un portail au niveau du <body> pour échapper
 * à l'overflow:hidden du sidebar. Sa position est calculée depuis le rect
 * du bouton trigger.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PanelSelectOption {
  value: string;
  label: string;
}

interface PanelSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: PanelSelectOption[];
  className?: string;
  placeholder?: string;
}

interface DropdownRect {
  top: number;
  left: number;
  width: number;
  openUpward: boolean;
}

export function PanelSelect({
  value,
  onChange,
  options,
  className,
  placeholder = "Select…",
}: PanelSelectProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DropdownRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find(o => o.value === value);

  const calcRect = useCallback(() => {
    if (!triggerRef.current) return null;
    const r = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    // Dropdown max-height ~220px; open upward if not enough space below
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
    return {
      top: openUpward ? r.top : r.bottom + 4,
      left: r.left,
      width: r.width,
      openUpward,
    };
  }, []);

  function handleOpen() {
    if (open) { setOpen(false); return; }
    const r = calcRect();
    setRect(r);
    setOpen(true);
  }

  // Reposition on scroll/resize
  useEffect(() => {
    if (!open) return;
    function update() {
      const r = calcRect();
      setRect(r);
    }
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, calcRect]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  function handleSelect(v: string) {
    onChange(v);
    setOpen(false);
  }

  const dropdown = open && rect ? (
    <div
      role="listbox"
      style={{
        position: "fixed",
        top: rect.openUpward ? undefined : rect.top,
        bottom: rect.openUpward ? window.innerHeight - rect.top + 4 : undefined,
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
      }}
      className={cn(
        "bg-[hsl(214,50%,8%)] border border-[hsl(214,45%,26%)] rounded-sm shadow-2xl",
        "overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150",
        rect.openUpward && "slide-in-from-bottom-1",
      )}
    >
      <div className="max-h-52 overflow-y-auto overscroll-contain divide-y divide-[hsl(214,45%,18%)]">
        {options.map(opt => {
          const isSelected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={isSelected}
              onPointerDown={e => { e.preventDefault(); handleSelect(opt.value); }}
              className={cn(
                "w-full text-left px-3 py-2 font-mono text-xs flex items-center gap-2 transition-colors",
                "text-[hsl(210,35%,88%)] hover:bg-primary/10 hover:text-[hsl(210,80%,90%)]",
                isSelected && "bg-primary/10 text-primary",
              )}
            >
              <span className="flex-1 truncate">{opt.label}</span>
              {isSelected && <Check className="w-3 h-3 text-primary shrink-0" />}
            </button>
          );
        })}
      </div>
      {/* Close strip */}
      <div className="border-t border-[hsl(214,45%,18%)] bg-[hsl(214,50%,6%)]">
        <button
          type="button"
          onPointerDown={e => { e.preventDefault(); setOpen(false); }}
          className="w-full py-1.5 text-[10px] font-mono text-[hsl(210,20%,40%)] hover:text-[hsl(210,20%,65%)] transition-colors tracking-wider uppercase"
        >
          Close
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className={cn("relative", className)}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        className={cn(
          "w-full h-9 pl-3 pr-8 rounded-sm border text-left font-mono text-xs flex items-center",
          "bg-[hsl(214,50%,10%)] border-[hsl(214,45%,26%)] text-[hsl(210,35%,88%)]",
          "focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30",
          "hover:border-[hsl(214,45%,34%)] transition-colors cursor-pointer",
          open && "border-primary/60 ring-1 ring-primary/30",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate flex-1">
          {selected
            ? selected.label
            : <span className="text-[hsl(210,20%,40%)]">{placeholder}</span>}
        </span>
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
          <ChevronDown
            className={cn(
              "w-3 h-3 text-[hsl(210,20%,55%)] transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </span>
      </button>

      {/* Portal dropdown — renders outside sidebar overflow */}
      {typeof document !== "undefined" && createPortal(dropdown, document.body)}
    </div>
  );
}
