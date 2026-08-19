import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 focus-visible:ring-offset-1 cursor-pointer",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-accent)] text-white border border-[var(--color-accent)] shadow-sm hover:brightness-110",
        accent:
          "bg-[var(--color-accent)] text-white border border-[var(--color-accent)] shadow-sm hover:brightness-110",
        ghost:
          "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-black/[0.04]",
        outline:
          "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-black/[0.03] shadow-sm",
        danger:
          "bg-[var(--color-accent-red-dim)] text-[var(--color-accent-red)] border border-[var(--color-accent-red)]/30 hover:bg-[var(--color-accent-red)]/15",
        success:
          "bg-[var(--color-accent-green-dim)] text-[var(--color-accent-green)] border border-[var(--color-accent-green)]/30 hover:bg-[var(--color-accent-green)]/15",
      },
      size: {
        sm: "h-8 px-3 text-xs rounded-md",
        md: "h-9 px-4 rounded-md",
        lg: "h-11 px-6 text-base rounded-md",
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

