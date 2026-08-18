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
    <main className="flex min-h-screen items-center justify-center px-4">
      <LoginForm
        locale={locale}
        showroomName={tenant?.name ?? null}
        // Non-null only on the flagship demo with the demo switched on.
        // The addresses stay on the server; only labels cross the wire.
        demoPersonas={demo ? demoPersonas() : null}
      />
    </main>
  );
}
