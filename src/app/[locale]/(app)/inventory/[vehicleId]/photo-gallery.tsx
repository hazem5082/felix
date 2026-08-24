"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A thumbnail strip that opens a fullscreen, dimmed lightbox on click —
 * used for both the sale gallery and the intake inspection set, which
 * carry the same "click to see it bigger" need but never share an array.
 * Not built on components/ui/dialog.tsx: that component skins a boxed
 * panel with a title bar, which is the wrong shape for an image that
 * should fill the screen edge-to-edge.
 */
export function PhotoGallery({
  photos,
  thumbClassName,
}: {
  photos: string[];
  thumbClassName: string;
}) {
  const [index, setIndex] = useState<number | null>(null);

  const close = useCallback(() => setIndex(null), []);
  const prev = useCallback(
    () => setIndex((i) => (i === null ? i : (i - 1 + photos.length) % photos.length)),
    [photos.length]
  );
  const next = useCallback(
    () => setIndex((i) => (i === null ? i : (i + 1) % photos.length)),
    [photos.length]
  );

  useEffect(() => {
    if (index === null) return;
    // Locked while open so the dimmed backdrop reads as a modal layer
    // rather than a page the user can still scroll behind.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [index, close, prev, next]);

  if (photos.length === 0) return null;

  return (
    <>
      <div className="flex gap-2 overflow-x-auto">
        {photos.map((p, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={p}
            src={p}
            alt=""
            loading={i === 0 ? "eager" : "lazy"}
            onClick={() => setIndex(i)}
            className={cn(thumbClassName, "cursor-zoom-in object-cover transition-opacity hover:opacity-90")}
          />
        ))}
      </div>

      {index !== null && (
        <div
          role="dialog"
          aria-modal="true"
          // overflow-auto: a portrait photo taller than the viewport
          // scrolls inside the backdrop instead of getting clipped.
          className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/85 p-4"
          onClick={close}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="fixed end-4 top-4 z-10 cursor-pointer rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X size={20} />
          </button>

          {photos.length > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous photo"
                onClick={(e) => { e.stopPropagation(); prev(); }}
                className="fixed start-4 top-1/2 z-10 -translate-y-1/2 cursor-pointer rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              >
                <ChevronLeft size={22} />
              </button>
              <button
                type="button"
                aria-label="Next photo"
                onClick={(e) => { e.stopPropagation(); next(); }}
                className="fixed end-4 top-1/2 z-10 -translate-y-1/2 cursor-pointer rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              >
                <ChevronRight size={22} />
              </button>
            </>
          )}

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photos[index]}
            alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full cursor-default object-contain"
          />

          {photos.length > 1 && (
            <p className="fixed bottom-4 start-1/2 z-10 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white">
              {index + 1} / {photos.length}
            </p>
          )}
        </div>
      )}
    </>
  );
}
