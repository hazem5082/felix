"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  className,
  children,
  title,
}: {
  className?: string;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <DialogPrimitive.Portal forceMount>
      {/* AnimatePresence tracks its direct children BY KEY — that is how it
          knows which one left and therefore which exit animation to run. Two
          keyless children collide on the same generated key, which React
          reports as `Encountered two children with the same key, ""` on every
          render of every open dialog in the app, and which leaves framer-motion
          unable to tell the overlay and the panel apart on exit. */}
      <AnimatePresence>
        <DialogPrimitive.Overlay key="overlay" asChild forceMount>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/35"
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content key="content" asChild forceMount>
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              // Positioning lives on THIS element and the panel skin on the
              // child, never together. `.panel` is unlayered CSS carrying
              // `position: relative` (its gradient border needs it), and
              // unlayered rules beat every Tailwind utility layer — so a
              // `panel fixed` combination silently loses `fixed`, and the
              // dialog renders in normal flow at the end of <body>: the
              // overlay blurs the page while the panel sits below the fold.
              // Every create-dialog in the app was invisible this way.
              "fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2",
              className
            )}
          >
            <div className="panel panel-raised max-h-[85vh] overflow-y-auto p-6 border border-[var(--color-border)] shadow-[0_20px_50px_rgba(23,26,33,0.18)] rounded-xl">
              <div className="mb-4 flex items-center justify-between">
                <DialogPrimitive.Title className="text-base font-semibold text-[var(--color-text)] tracking-wide">
                  {title}
                </DialogPrimitive.Title>
                <DialogPrimitive.Close className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-black/[0.05] hover:text-[var(--color-text)] transition-colors">
                  <X size={16} />
                </DialogPrimitive.Close>
              </div>
              {children}
            </div>
          </motion.div>
        </DialogPrimitive.Content>
      </AnimatePresence>
    </DialogPrimitive.Portal>
  );
}

