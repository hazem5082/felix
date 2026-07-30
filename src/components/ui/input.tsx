import { cn } from "@/lib/utils";
import { forwardRef } from "react";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9.5 w-full rounded-xl border border-white/15 bg-white/[0.04] backdrop-blur-md px-3.5 text-sm text-white placeholder:text-white/40 outline-none transition-all duration-200 focus:border-cyan-400/60 focus:bg-white/[0.07] focus:ring-4 focus:ring-cyan-500/15 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)]",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-xl border border-white/15 bg-white/[0.04] backdrop-blur-md px-3.5 py-2.5 text-sm text-white placeholder:text-white/40 outline-none transition-all duration-200 focus:border-cyan-400/60 focus:bg-white/[0.07] focus:ring-4 focus:ring-cyan-500/15 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)]",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]", className)}
      {...props}
    />
  );
}

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-9.5 w-full rounded-xl border border-white/15 bg-white/[0.04] backdrop-blur-md px-3.5 text-sm text-white outline-none transition-all duration-200 focus:border-cyan-400/60 focus:bg-white/[0.07] focus:ring-4 focus:ring-cyan-500/15 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)]",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";

