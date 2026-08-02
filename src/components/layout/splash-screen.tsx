"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

const TYPE_MS = 1100;
const HOLD_MS = 350;
const EXIT_MS = 450;

/**
 * Replayed on every full page load, this splash was the single biggest
 * "the app is broken" generator in production: a fullscreen z-[999]
 * overlay WITHOUT pointer-events-none sat over the page for ~5.5s per
 * navigation, silently eating every click. The page underneath looked
 * ready — buttons visible, forms rendered — so users clicked, nothing
 * happened, and every input appeared dead. (Verified live: the same
 * click that did nothing during the overlay creates a lead once it's
 * gone.)
 *
 * Three rules keep it harmless now:
 *  1. pointer-events-none, always. It is decoration; it may never
 *     intercept input, not even for one frame.
 *  2. Once per browser session. A brand moment on arrival is polish;
 *     replaying it on every hard navigation is a 5-second toll booth.
 *  3. Short. The old 4.75s was longer than most page loads.
 */
const SEEN_KEY = "felix-splash-seen";

type Phase = "typing" | "hidden";

export function SplashScreen({ children }: { children: React.ReactNode }) {
  // Server and first client render agree on "typing" (no hydration
  // mismatch); the effect below hides it immediately when this session
  // has already seen it.
  const [phase, setPhase] = useState<Phase>("typing");
  const pathname = usePathname();

  // Print views (contracts, reports) open in a new tab headed straight
  // for the print dialog — a branding animation there is at best a
  // flash and at worst ends up ON the printed page.
  const isPrintRoute = pathname?.includes("/print/") ?? false;

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === "1";
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Storage blocked (private mode etc.) — worst case the splash
      // replays; it can't block anything either way.
    }
    if (seen) {
      setPhase("hidden");
      return;
    }
    const t = setTimeout(() => setPhase("hidden"), TYPE_MS + HOLD_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      {children}
      <AnimatePresence>
        {phase !== "hidden" && !isPrintRoute && (
          <motion.div
            className="pointer-events-none fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden bg-[#060709]"
            exit={{ opacity: 0, scale: 1.02, filter: "blur(10px)" }}
            transition={{ duration: EXIT_MS / 1000, ease: [0.4, 0, 0.2, 1] }}
          >
            {/* Single centered white light source in the background */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.03) 40%, transparent 70%)",
              }}
            />

            {/* Subtle starlight noise grid */}
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.2]"
              style={{
                backgroundImage:
                  "radial-gradient(1px 1px at 15% 25%, white, transparent)," +
                  "radial-gradient(1px 1px at 85% 15%, white, transparent)," +
                  "radial-gradient(1px 1px at 28% 80%, white, transparent)," +
                  "radial-gradient(1.5px 1.5px at 70% 70%, white, transparent)," +
                  "radial-gradient(1px 1px at 90% 55%, white, transparent)," +
                  "radial-gradient(1px 1px at 45% 15%, white, transparent)",
              }}
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 flex flex-col items-center gap-8"
            >
              <div className="relative">
                {/* Typed logo reveal */}
                <motion.div
                  initial={{ clipPath: "inset(0 100% 0 0)" }}
                  animate={{ clipPath: "inset(0 0% 0 0)" }}
                  transition={{ duration: TYPE_MS / 1000, ease: [0.65, 0, 0.35, 1] }}
                >
                  <Image
                    src="/brand/felix-logo.png"
                    alt="FELIX"
                    width={560}
                    height={180}
                    priority
                    className="h-auto w-[min(80vw,480px)] drop-shadow-[0_0_40px_rgba(255,255,255,0.35)]"
                  />
                </motion.div>

                {/* Sweeping caret */}
                <motion.div
                  className="absolute bottom-0 top-0 w-[3.5px] rounded-full bg-white shadow-[0_0_16px_4px_rgba(255,255,255,0.95)]"
                  initial={{ left: "0%" }}
                  animate={{ left: "100%" }}
                  transition={{ duration: TYPE_MS / 1000, ease: [0.65, 0, 0.35, 1] }}
                />
              </div>

              {/* Progress bar */}
              <div className="relative h-[2.5px] w-56 overflow-hidden rounded-full bg-white/15">
                <motion.div
                  className="h-full rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.9)]"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: (TYPE_MS + HOLD_MS) / 1000, ease: "linear" }}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
