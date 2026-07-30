import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 active:scale-[0.98] cursor-pointer",
  {
    variants: {
      variant: {
        primary:
          "bg-gradient-to-b from-white/15 to-white/5 backdrop-blur-md border border-white/20 text-white shadow-[0_4px_16px_rgba(0,0,0,0.3),inset_0_1px_1px_rgba(255,255,255,0.3)] hover:border-white/35 hover:from-white/25 hover:to-white/10 hover:shadow-[0_6px_20px_rgba(0,0,0,0.4),0_0_15px_rgba(255,255,255,0.1)]",
        accent:
          "bg-gradient-to-b from-blue-500 to-blue-600 text-white border border-blue-400/40 shadow-[0_4px_16px_rgba(59,130,246,0.35),inset_0_1px_1px_rgba(255,255,255,0.35)] hover:from-blue-400 hover:to-blue-500 hover:shadow-[0_6px_20px_rgba(59,130,246,0.5)]",
        ghost:
          "text-[var(--color-text-muted)] hover:text-white hover:bg-white/10 backdrop-blur-sm",
        outline:
          "border border-white/15 bg-white/[0.03] backdrop-blur-md text-white hover:bg-white/10 hover:border-white/25 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]",
        danger:
          "bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)] border border-[var(--color-accent-red)]/40 hover:bg-[var(--color-accent-red)]/30 backdrop-blur-md",
        success:
          "bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)] border border-[var(--color-accent-green)]/40 hover:bg-[var(--color-accent-green)]/30 backdrop-blur-md",
      },
      size: {
        sm: "h-8 px-3 text-xs rounded-lg",
        md: "h-9 px-4 rounded-xl",
        lg: "h-11 px-6 text-base rounded-xl",
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

