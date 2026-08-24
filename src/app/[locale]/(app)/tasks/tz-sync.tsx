"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Tell the server what day it is where the reader is standing.
 *
 * The server runs on Cloudflare Workers, which is always UTC, so "today"
 * computed there is the wrong day for a Cairo showroom for the last three
 * hours of every evening and for a Los Angeles one for most of the
 * morning. Every other date window in FELIX takes the viewer's offset as
 * a `tz` search param (src/lib/report-window.ts); this component is what
 * actually puts it there.
 *
 * TWO DELIBERATE CHOICES, both of which were the other way round first
 * and did not work:
 *
 *   * The URL is read from `window.location` inside the effect rather
 *     than from useSearchParams(). That hook forces the route into a
 *     Suspense boundary to render, which is a lot of machinery for a
 *     value only ever needed on the client, after mount.
 *
 *   * The router is next/navigation's, not @/i18n/navigation's, and the
 *     path handed to it is the real one — locale prefix and all. The
 *     localized router takes a locale-less href and re-derives the
 *     prefix; feeding it a query string it did not expect produced a
 *     replace that silently did nothing, which is exactly the failure
 *     mode a timezone fix must not have, because the page still renders
 *     perfectly well on the wrong day.
 *
 * ONCE, AND ONLY WHEN IT MATTERS. A reader already on UTC gets no
 * replace at all, and a reader who has the param gets none either.
 * `replace` rather than `push`, so the back button leaves the page
 * rather than undoing a correction the reader never made.
 *
 * Deliberately not a cookie: one set on a laptop and read on a phone is
 * the bug this exists to fix, and a search param is visible in the URL —
 * the right amount of honesty for a value that decides which day
 * somebody's work is filed under.
 */
export function TzSync() {
  const router = useRouter();

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("tz")) return;

    // Minutes EAST of UTC, which is the sign parseOffset() expects and
    // the opposite of what getTimezoneOffset() returns.
    const offset = -new Date().getTimezoneOffset();
    if (offset === 0) return;

    url.searchParams.set("tz", String(offset));
    router.replace(`${url.pathname}${url.search}`);
  }, [router]);

  return null;
}
