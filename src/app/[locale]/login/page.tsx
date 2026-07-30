import { getProfile, defaultRouteForRole } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";
import { getTenant } from "@/lib/tenant";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const profile = await getProfile();
  if (profile) {
    redirect({ href: defaultRouteForRole(profile.role), locale });
  }

  const tenant = await getTenant();

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <LoginForm locale={locale} showroomName={tenant?.name ?? null} />
    </main>
  );
}
