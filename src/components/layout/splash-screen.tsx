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
            className="fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden bg-[#07080a]"
            exit={{ opacity: 0, scale: 1.03, filter: "blur(12px)" }}
            transition={{ duration: EXIT_MS / 1000, ease: [0.4, 0, 0.2, 1] }}
          >
            {/* Ambient liquid glass floating backdrop glow orbs */}
            <motion.div
              className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-indigo-600/20 blur-[100px]"
              animate={{ scale: [1, 1.25, 1], x: [0, 30, 0], y: [0, 40, 0] }}
              transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-cyan-600/20 blur-[100px]"
              animate={{ scale: [1, 1.3, 1], x: [0, -40, 0], y: [0, -30, 0] }}
              transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="pointer-events-none absolute top-1/2 left-1/2 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-purple-600/15 blur-[120px]"
              animate={{ scale: [0.9, 1.1, 0.9] }}
              transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
            />

            {/* Subtle starlight noise grid */}
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.25]"
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

            {/* Liquid Glass Central Container */}
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="relative flex flex-col items-center gap-8 rounded-3xl border border-white/15 bg-white/[0.03] p-10 sm:p-14 backdrop-blur-2xl shadow-[0_20px_60px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.25)]"
            >
              {/* Glass sheen highlight top edge */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent rounded-t-3xl" />

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
                    width={420}
                    height={140}
                    priority
                    className="h-auto w-[min(60vw,340px)] drop-shadow-[0_0_35px_rgba(180,210,255,0.4)]"
                  />
                </motion.div>

                {/* Sweeping & Continuously Blinking Caret */}
                <motion.div
                  className="absolute top-0 bottom-0 w-[3px] rounded-full bg-cyan-300 shadow-[0_0_12px_3px_rgba(56,189,248,0.9)]"
                  initial={{ left: "0%" }}
                  animate={{ left: "100%" }}
                  transition={{ duration: TYPE_MS / 1000, ease: [0.65, 0, 0.35, 1] }}
                >
                  <motion.div
                    className="h-full w-full bg-cyan-200"
                    animate={{ opacity: [1, 0, 1] }}
                    transition={{
                      duration: 0.6,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  />
                </motion.div>
              </div>

              {/* Liquid Glass Progress Bar */}
              <div className="relative h-[3px] w-48 overflow-hidden rounded-full bg-white/10 p-[0.5px] backdrop-blur-md">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-white to-purple-400 shadow-[0_0_10px_rgba(255,255,255,0.8)]"
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
