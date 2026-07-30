"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";

const TYPE_MS = 2600; // Decreased speed (longer typing reveal)
const HOLD_MS = 1400; // Increased hold time
const EXIT_MS = 750;  // Smooth exit duration

type Phase = "typing" | "exiting" | "hidden";

export function SplashScreen({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("typing");

  useEffect(() => {
    const toExit = setTimeout(() => setPhase("exiting"), TYPE_MS + HOLD_MS);
    const toHidden = setTimeout(() => setPhase("hidden"), TYPE_MS + HOLD_MS + EXIT_MS);
    return () => {
      clearTimeout(toExit);
      clearTimeout(toHidden);
    };
  }, []);

  return (
    <>
      {children}
      <AnimatePresence>
        {phase !== "hidden" && (
          <motion.div
            className="fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden bg-[#060709]"
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

            {/* Direct Content Wrapper (No glass card container) */}
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="relative flex flex-col items-center gap-8 z-10"
            >
              <div className="relative">
                {/* Typed logo reveal - enlarged */}
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

                {/* Sweeping & Continuously Blinking White Caret */}
                <motion.div
                  className="absolute top-0 bottom-0 w-[3.5px] rounded-full bg-white shadow-[0_0_16px_4px_rgba(255,255,255,0.95)]"
                  initial={{ left: "0%" }}
                  animate={{ left: "100%" }}
                  transition={{ duration: TYPE_MS / 1000, ease: [0.65, 0, 0.35, 1] }}
                >
                  <motion.div
                    className="h-full w-full bg-white"
                    animate={{ opacity: [1, 0, 1] }}
                    transition={{
                      duration: 0.6,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  />
                </motion.div>
              </div>

              {/* Sleek White Progress Bar */}
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

