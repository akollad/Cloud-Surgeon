/**
 * PanelSelect — composant réutilisable pour les selects du panneau Controls.
 *
 * Remplace le <select> natif par un dropdown custom cohérent avec le style
 * des pickers d'incidents (dark theme, mono, animations fluides).
 *
 * Fonctionnalités :
 * - Trigger bouton affichant la valeur sélectionnée + chevron animé
 * - Dropdown positionné avec liste d'options scrollable
 * - Fermeture : clic en dehors, touche Escape, sélection
 * - Animation d'entrée / sortie (fade + slide)
 * - Support label ≠ value
 */

import { useState, useEffect, useRef } from "react";
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

export function PanelSelect({
  value,
  onChange,
  options,
  className,
  placeholder = "Select…",
}: PanelSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.value === value);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
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
          {selected ? selected.label : <span className="text-[hsl(210,20%,40%)]">{placeholder}</span>}
        </span>
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
          <ChevronDown
            className={cn(
              "w-3 h-3 text-[hsl(210,20%,55%)] transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute left-0 right-0 z-50 mt-1",
            "bg-[hsl(214,50%,8%)] border border-[hsl(214,45%,26%)] rounded-sm shadow-xl",
            "overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150",
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
                  onClick={() => handleSelect(opt.value)}
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
              onClick={() => setOpen(false)}
              className="w-full py-1.5 text-[10px] font-mono text-[hsl(210,20%,40%)] hover:text-[hsl(210,20%,65%)] transition-colors tracking-wider uppercase"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
