import * as React from "react"
import { cn } from "@/lib/utils"

// A simple local Tabs implementation for density and speed
const TabsContext = React.createContext<{
  value: string;
  onValueChange: (value: string) => void;
} | null>(null);

export function Tabs({ 
  value, 
  defaultValue, 
  onValueChange, 
  children,
  className
}: { 
  value?: string; 
  defaultValue?: string; 
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [active, setActive] = React.useState(value || defaultValue || "");
  
  React.useEffect(() => {
    if (value !== undefined) setActive(value);
  }, [value]);

  const handleValueChange = (val: string) => {
    if (value === undefined) setActive(val);
    onValueChange?.(val);
  };

  return (
    <TabsContext.Provider value={{ value: active, onValueChange: handleValueChange }}>
      <div className={cn("flex flex-col w-full", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("inline-flex h-9 items-center justify-start bg-transparent border-b border-border p-0 overflow-x-auto", className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error("TabsTrigger must be used within Tabs");
  
  const isActive = context.value === value;
  
  return (
    <button
      type="button"
      onClick={() => context.onValueChange(value)}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap px-4 py-1.5 text-sm font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 font-mono uppercase tracking-tight text-muted-foreground border-b-2 border-transparent hover:text-foreground",
        isActive && "border-primary text-foreground bg-primary/5",
        className
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error("TabsContent must be used within Tabs");
  
  if (context.value !== value) return null;
  
  return (
    <div className={cn("mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", className)}>
      {children}
    </div>
  );
}
