import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 font-mono uppercase tracking-tight",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        // Status variants
        triggered: "border-blue-500/50 bg-blue-500/10 text-blue-400 pulse-blue",
        diagnosing: "border-yellow-500/50 bg-yellow-500/10 text-yellow-400 pulse-yellow",
        repairing: "border-orange-500/50 bg-orange-500/10 text-orange-400 pulse-orange",
        resolved: "border-green-500/50 bg-green-500/10 text-green-400",
        failed: "border-red-500/50 bg-red-500/10 text-red-400",
        pending_approval: "border-yellow-500 bg-yellow-500 text-black blink-yellow",
        predictive: "border-purple-500/50 bg-purple-500/10 text-purple-400",
        // Routing modes
        autonomous: "border-green-500/30 text-green-400 bg-transparent",
        exploratory: "border-blue-500/30 text-blue-400 bg-transparent",
        rejected: "border-red-500/30 text-red-400 bg-transparent",
        // Sources
        bedrock: "border-purple-500/30 text-purple-400 bg-transparent",
        anthropic: "border-cyan-500/30 text-cyan-400 bg-transparent",
        simulated: "border-gray-500/30 text-gray-400 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
