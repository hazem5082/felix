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

// The browser talks directly to Supabase (auth + PostgREST + realtime), to R2
// for presigned uploads, and to the NHTSA vPIC API for the make/model picker.
// Everything else is same-origin, so the policy can stay tight.
const connectSrc = [
  "'self'",
  supabaseOrigin,
  supabaseOrigin.replace(/^https:/, "wss:"),
  r2Origin,
  "https://*.r2.cloudflarestorage.com",
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
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // A stack trace on a financial system's error page is a reconnaissance gift.
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  images: {
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
