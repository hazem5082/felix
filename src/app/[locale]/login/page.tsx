import { getProfile, defaultRouteForRole } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";
import { getTenant } from "@/lib/tenant";
import { demoPersonas, getDemoStatus, isFlagshipDemo } from "@/lib/demo";
import { DemoOffNotice } from "@/components/demo/demo-off-notice";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const tenant = await getTenant();

  // The demo-off gate runs BEFORE the already-signed-in redirect, on
  // purpose. This page is where requireActiveTenant() sends anyone who
  // hits a /print route while the demo is off, and it is where a signed-in
  // visitor lands after the shell refuses them — bouncing them onward to
  // a dashboard would make them chase the notice around the app instead
  // of reading it.
  //
  // For every licensed showroom isFlagshipDemo() is false, `demo` stays
  // null, and this page behaves exactly as it did before.
  const demo = isFlagshipDemo(tenant) ? await getDemoStatus() : null;
  if (demo && !demo.enabled) {
    return <DemoOffNotice offMessage={demo.offMessage} />;
  }

  const profile = await getProfile();
  if (profile) {
    redirect({ href: defaultRouteForRole(profile.role), locale });
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center p-4 sm:p-6 lg:p-8 bg-[var(--color-bg)]">
      {/* Background ambient lighting */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 h-96 w-[36rem] rounded-full bg-gradient-to-tr from-amber-200/20 via-indigo-100/30 to-blue-200/20 blur-3xl" />
        <div className="absolute -bottom-32 right-1/4 h-80 w-96 rounded-full bg-gradient-to-br from-amber-100/20 to-orange-100/10 blur-3xl" />
      </div>

      <div className="relative z-10 w-full flex justify-center">
        <LoginForm
          locale={locale}
          showroomName={tenant?.name ?? null}
          // Non-null only on the flagship demo with the demo switched on.
          // The addresses stay on the server; only labels cross the wire.
          demoPersonas={demo ? demoPersonas() : null}
        />
      </div>
    </main>
  );
}
