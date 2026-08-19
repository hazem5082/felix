"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The manufacturer's badge next to a make name.
 *
 * WHY THERE IS NO LOGO CDN BEHIND THIS. Car marques are registered
 * trademarks. Hot-linking them from a third-party logo API puts a dependency
 * you do not control — and someone else's licence terms — on the inventory
 * screen of a system that prints sale contracts; and vendoring the files would
 * ship trademarked artwork inside the product. Neither is ours to decide, so
 * this component does neither by default.
 *
 * What it does instead:
 *
 *   1. Reads `/brand-logos/manifest.json`, a list of the slugs that actually
 *      have a file, and renders `<img src="/brand-logos/<slug>.svg">` only for
 *      those. Drop a properly licensed file in `public/brand-logos/`, add its
 *      slug to the manifest, and it appears here with no code change.
 *   2. Falls back to a monogram in a colour derived from the make's own name,
 *      so all ~400 makes get a stable, distinguishable mark immediately.
 *
 * WHY A MANIFEST RATHER THAN "TRY THE IMAGE AND CATCH onError". Because the
 * folder ships empty, the optimistic version fired a 404 for every make the
 * user could see — opening the make picker alone produced 400+ failed requests
 * in the network log and the console, on every deployment that had not yet
 * added logos. `loading="lazy"` does not help: the rows are inside a scrolling
 * listbox that is already in the viewport. One fetch of a manifest that says
 * "nothing here" costs one request and stays quiet.
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

// Fetched once per session, shared by every badge on the page.
let manifest: Set<string> | null = null;
let manifestInFlight: Promise<Set<string>> | null = null;
const subscribers = new Set<() => void>();

function loadManifest(): Promise<Set<string>> {
  if (manifest) return Promise.resolve(manifest);
  if (manifestInFlight) return manifestInFlight;

  manifestInFlight = fetch("/brand-logos/manifest.json")
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((list: unknown) => {
      manifest = new Set(Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : []);
      manifestInFlight = null;
      // Badges that already rendered their monogram need to hear about it.
      subscribers.forEach((fn) => fn());
      return manifest;
    });

  return manifestInFlight;
}

export function BrandMark({
  make,
  size = 18,
  className,
}: {
  make: string;
  size?: number;
  className?: string;
}) {
  const [, bump] = useState(0);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (manifest) return;
    const rerender = () => bump((n) => n + 1);
    subscribers.add(rerender);
    loadManifest();
    return () => {
      subscribers.delete(rerender);
    };
  }, []);

  if (!make) return null;

  const slug = brandSlug(make);
  const hasLogo = manifest?.has(slug) && !broken;

  if (hasLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/brand-logos/${slug}.svg`}
        alt=""
        aria-hidden
        width={size}
        height={size}
        // The manifest can still be out of step with the folder — a listed
        // file that was removed must not leave a broken glyph behind.
        onError={() => setBroken(true)}
        className={cn("shrink-0 rounded-full object-contain", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  const hue = hueFor(make);
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
        backgroundColor: `hsl(${hue} 70% 94%)`,
        color: `hsl(${hue} 55% 32%)`,
        border: `1px solid hsl(${hue} 50% 80%)`,
      }}
    >
      {initials(make)}
    </span>
  );
}
