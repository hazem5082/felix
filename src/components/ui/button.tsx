import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-blue)]/50",
  {
    variants: {
      variant: {
        primary:
          "bg-gradient-to-b from-[#3a3f47] to-[#26292f] text-white border border-[var(--color-border-strong)] shadow-[0_1px_0_0_rgba(255,255,255,0.08)_inset,0_1px_3px_rgba(0,0,0,0.4)] hover:from-[#454b54] hover:to-[#2c2f36] active:translate-y-px",
        accent:
          "bg-[var(--color-accent-blue)] text-white hover:brightness-110 active:translate-y-px",
        ghost:
          "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5",
        outline:
          "border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-white/5",
        danger:
          "bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)] border border-[var(--color-accent-red)]/30 hover:bg-[var(--color-accent-red)]/20",
        success:
          "bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)] border border-[var(--color-accent-green)]/30 hover:bg-[var(--color-accent-green)]/20",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-6",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";
