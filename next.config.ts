import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const supabaseOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    return "";
  }
})();

const r2Origin = (() => {
  try {
    return new URL(process.env.R2_PUBLIC_URL ?? "").origin;
  } catch {
    return "";
  }
})();

// Where storage bytes come from. createSignedDownloadUrl() signs against
// the S3 endpoint, while unsigned public assets are served from
// R2_PUBLIC_URL's r2.dev (or custom) domain, so both belong anywhere the
// browser reaches for a stored file.
const r2Sources = [r2Origin, "https://*.r2.cloudflarestorage.com"].filter(Boolean);

// The browser talks directly to Supabase (auth + PostgREST + realtime), to R2
// for presigned uploads, and to the NHTSA vPIC API for the make/model picker.
// Everything else is same-origin, so the policy can stay tight.
const connectSrc = [
  "'self'",
  supabaseOrigin,
  supabaseOrigin.replace(/^https:/, "wss:"),
  ...r2Sources,
  "https://vpic.nhtsa.dot.gov",
]
  .filter(Boolean)
  .join(" ");

const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts and streams RSC payloads inline;
  // 'unsafe-inline' is required until a nonce-based setup is wired through
  // the adapter. 'unsafe-eval' is dev-only: webpack's HMR runtime evals each
  // module for fast refresh, and the CSP silently kills hydration without it.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${connectSrc}`,
  // Mail attachment previews point an <iframe> (PDF) or <video> at the
  // same-origin /api/mail/attachment/[id]?preview=1, which 302s to a
  // 60-second signed R2 URL — and CSP re-checks the policy against a
  // redirect's destination, so a same-origin src is not enough on its
  // own. With neither directive set both fell back to default-src
  // 'self', and Chrome painted its own "This content is blocked" page
  // inside the preview dialog: no console error, no network failure the
  // app could see, nothing to fall back to Download from. The geofence
  // map frame (google.com/maps/embed) was blocked the same way.
  `frame-src ${["'self'", ...r2Sources, "https://www.google.com"].join(" ")}`,
  `media-src ${["'self'", "blob:", ...r2Sources].join(" ")}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // geolocation=(self), NOT () — the attendance geofence calls
  // getCurrentPosition (punch-card, geofence-panel). With () the browser
  // denies silently, without ever showing a prompt, and every punch
  // degrades to null coordinates: the feature is dead while looking
  // merely "unavailable". (self) still blocks third parties.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Two dev servers on one checkout share `.next` and overwrite each
  // other's manifests: routes-manifest.json and the client chunks go
  // missing, every route 500s with "Cannot find module for page", and
  // nothing hydrates — a failure that looks exactly like a bug in
  // whatever you last edited. `NEXT_DIST_DIR=.next-<name> npm run dev`
  // gives a session its own build directory. Unset, this is the plain
  // `.next` Next.js would have used anyway, so nothing changes for a
  // normal run or for the Cloudflare build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    root: __dirname,
  },
  experimental: {
    serverActions: {
      // FELIX is served through the 508.world Worker, which proxies to this
      // Worker's own origin. Next compares the browser's `Origin` against the
      // forwarded host as a CSRF defence, and through a proxy those differ:
      // Origin is `demo-felix.508.world` while x-forwarded-host is
      // `filex.…workers.dev`. Without this, EVERY Server Action — login
      // included — dies with "Invalid Server Actions request" and a 500,
      // while ordinary page loads keep working, which makes it look like an
      // auth bug rather than a proxy one.
      //
      // The Worker also sets X-Forwarded-Host to the public hostname, which
      // fixes the mismatch at source; this list is the second layer, and is
      // what keeps direct *.workers.dev access working too.
      //
      // `*.508.world` used to be here and has been removed. Next's origin
      // check is the ONLY CSRF defence on Server Actions, and Supabase's
      // cookies are SameSite=Lax — which still rides along on a POST from a
      // sibling subdomain, because that is same-*site*. The wildcard
      // therefore made every mutating action (updateEmployee,
      // resetEmployeePassword, executeSale) reachable from any other
      // 508.world host — a zone shared with separately-deployed products,
      // each with its own XSS and dangling-CNAME surface.
      //
      // Tenant hosts are dynamic (<slug>-felix.508.world) so they cannot be
      // enumerated here, and a partial-label pattern would NOT work: Next's
      // matchWildcardDomain only treats `*` as a whole label. They do not
      // need to be listed — the Worker's X-Forwarded-Host makes origin and
      // host agree for all proxied traffic, so this list is consulted only
      // for direct-to-Worker access.
      // `felix.508.world` was dropped when it became the static product page:
      // it no longer serves this app, and leaving it allow-listed would let a
      // compromise of that separately-deployed page reach mutating actions
      // here with same-site cookies attached.
      allowedOrigins: ["demo-felix.508.world", "filex.wejdan-arts-studio.workers.dev"],
    },
  },
  // A stack trace on a financial system's error page is a reconnaissance gift.
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "**.r2.dev" },
      { protocol: "https", hostname: "**.r2.cloudflarestorage.com" },
    ],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Nothing under /api is cacheable, and some of it is per-user.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
