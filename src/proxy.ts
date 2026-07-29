import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { refreshSession } from "@/lib/supabase/proxy-session";

const intlMiddleware = createIntlMiddleware(routing);

// Next.js 16 renamed Middleware to Proxy (same mechanism). This one
// file does two jobs: refresh the Supabase session cookie, then hand
// off to next-intl for locale-prefixed routing.
export async function proxy(request: NextRequest) {
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
