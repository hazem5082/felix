"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The manufacturer's badge next to a make name.
 *
 * WHY THERE IS NO LOGO CDN BEHIND THIS. Car marques are registered
 * trademarks. Hot-linking them from a third-party logo API puts a
 * dependency you do not control — and someone else's licence terms — on the
 * inventory screen of a system that prints sale contracts; and vendoring the
 * files would ship trademarked artwork inside the product. Neither is ours to
 * decide, so this component does neither by default.
 *
 * What it does instead:
 *
 *   1. Tries `/brand-logos/<slug>.svg`. Drop a properly licensed file in
 *      `public/brand-logos/` — `toyota.svg`, `mercedes-benz.svg`, `bmw.svg` —
 *      and it appears here with no code change. Nothing breaks when the file
 *      is absent, which is why the whole set does not have to arrive at once.
 *   2. Falls back to a monogram in a colour derived from the make's own name,
 *      so all ~400 makes get a stable, distinguishable mark immediately.
 *
 * The fallback is deterministic: the same make is the same colour on every
 * screen and every session, which is what makes it scannable in a grid.
 */
export function brandSlug(make: string): string {
  return make
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Stable hue per make — FNV-1a, so it does not drift between renders. */
function hueFor(make: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < make.length; i++) {
    h ^= make.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 360;
}

function initials(make: string): string {
  const words = make.trim().split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Slugs already known to have no file. The image is server-rendered, so
 * without this every one of the ~400 rows in the make picker would fire its
 * own 404 on first paint, and again on every reopen. One miss per make per
 * session is enough to learn from. Module scope, not state: the answer is a
 * property of the deployment, not of any component instance.
 */
const missingLogos = new Set<string>();

export function BrandMark({
  make,
  size = 18,
  className,
}: {
  make: string;
  size?: number;
  className?: string;
}) {
  const slug = brandSlug(make);
  const [missing, setMissing] = useState(() => missingLogos.has(slug));
  const imgRef = useRef<HTMLImageElement>(null);

  // The <img> is server-rendered, so the browser may finish (and fail) the
  // request before React hydrates and attaches onError — in which case the
  // handler never fires and a broken-image glyph stays on screen. A complete
  // image with zero intrinsic width is exactly that case.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0) {
      missingLogos.add(slug);
      setMissing(true);
    }
  }, [slug]);

  if (!make) return null;

  const hue = hueFor(make);

  if (missing) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none",
          className
        )}
        style={{
          width: size,
          height: size,
          fontSize: Math.max(8, size * 0.4),
          backgroundColor: `hsl(${hue} 55% 22%)`,
          color: `hsl(${hue} 85% 78%)`,
          border: `1px solid hsl(${hue} 60% 40% / 0.5)`,
        }}
      >
        {initials(make)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={`/brand-logos/${slug}.svg`}
      alt=""
      aria-hidden
      loading="lazy"
      width={size}
      height={size}
      onError={() => {
        missingLogos.add(slug);
        setMissing(true);
      }}
      className={cn("shrink-0 rounded-full object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}
