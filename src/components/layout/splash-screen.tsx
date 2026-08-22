"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

const SHOW_MS = 1200;
const EXIT_MS = 400;

/**
 * Replayed on first visit per session, harmless and fast:
 *  1. pointer-events-none, always so it never intercepts clicks.
 *  2. Once per browser session to prevent redundant delays.
 *  3. Short, clean transition matching the light UI theme.
 */
const SEEN_KEY = "felix-splash-seen";

type Phase = "showing" | "hidden";

export function SplashScreen({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("showing");
  const pathname = usePathname();

  // Print views open in a new tab headed straight for the print dialog
  const isPrintRoute = pathname?.includes("/print/") ?? false;

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === "1";
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Storage blocked (private mode etc.)
    }
    if (seen) {
      setPhase("hidden");
      return;
    }
    const t = setTimeout(() => setPhase("hidden"), SHOW_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      {children}
      <AnimatePresence>
        {phase !== "hidden" && !isPrintRoute && (
          <motion.div
            className="pointer-events-none fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden bg-white"
            exit={{ opacity: 0, scale: 1.01, filter: "blur(8px)" }}
            transition={{ duration: EXIT_MS / 1000, ease: [0.4, 0, 0.2, 1] }}
          >
            {/* Ambient Pink Spotlights */}
            <div
              className="pointer-events-none absolute -top-28 -left-28 h-[480px] w-[480px] rounded-full bg-gradient-to-br from-pink-400/20 via-pink-300/10 to-transparent blur-[100px]"
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute -bottom-28 -right-28 h-[480px] w-[480px] rounded-full bg-gradient-to-tl from-pink-500/18 via-rose-300/10 to-transparent blur-[100px]"
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-gradient-to-r from-pink-200/20 via-rose-100/15 to-transparent blur-[120px]"
              aria-hidden="true"
            />

            {/* Subtle radial center highlight */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(circle at 50% 50%, rgba(253, 242, 248, 0.6) 0%, rgba(255, 255, 255, 0) 70%)",
              }}
              aria-hidden="true"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 flex flex-col items-center gap-8"
            >
              <div className="relative">
                <Image
                  src="/brand/felix-logo.png"
                  alt="FELIX"
                  width={620}
                  height={200}
                  priority
                  className="h-auto w-[min(85vw,540px)] object-contain drop-shadow-[0_12px_28px_rgba(244,114,182,0.14)]"
                />
              </div>

              {/* Minimal Progress Bar */}
              <div className="relative h-[2.5px] w-56 overflow-hidden rounded-full bg-pink-100/80">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-pink-500 via-rose-400 to-pink-500 shadow-[0_0_10px_rgba(244,114,182,0.6)]"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: SHOW_MS / 1000, ease: [0.25, 0.1, 0.25, 1] }}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

