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
      <AnimatePresence>
        <DialogPrimitive.Overlay asChild forceMount>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xl"
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content asChild forceMount>
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
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
            <div className="panel panel-raised max-h-[85vh] overflow-y-auto p-6 border border-white/20 shadow-[0_25px_70px_rgba(0,0,0,0.7),inset_0_1px_1px_rgba(255,255,255,0.25)] rounded-2xl">
              <div className="mb-4 flex items-center justify-between">
                <DialogPrimitive.Title className="text-base font-semibold text-white tracking-wide">
                  {title}
                </DialogPrimitive.Title>
                <DialogPrimitive.Close className="rounded-lg p-1 text-[var(--color-text-muted)] hover:bg-white/10 hover:text-white transition-colors">
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

