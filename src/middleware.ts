import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { refreshSession } from "@/lib/supabase/proxy-session";

const intlMiddleware = createIntlMiddleware(routing);

// Runs on every request (Edge runtime): refreshes the Supabase session
// cookie, then hands off to next-intl for locale-prefixed routing.
// (Named `middleware.ts` — Next 16 renamed this to `proxy.ts`/Proxy and
// defaults it to the Node.js runtime, but the Cloudflare/OpenNext adapter
// doesn't yet support Node.js-runtime middleware, so this project is
// pinned to Next 15 where Edge middleware is still the default.)
export async function middleware(request: NextRequest) {
  const sessionResponse = await refreshSession(request);

  const intlResponse = intlMiddleware(request);
  if (intlResponse) {
    sessionResponse.cookies.getAll().forEach((cookie) => {
      intlResponse.cookies.set(cookie.name, cookie.value);
    });
    return intlResponse;
  }

  return sessionResponse ?? NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
