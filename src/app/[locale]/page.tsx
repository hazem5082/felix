import { getProfile, defaultRouteForRole } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";

export default async function RootPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const profile = await getProfile();

  if (!profile) {
    redirect({ href: "/login", locale });
  }
  redirect({ href: defaultRouteForRole(profile!.role), locale });
}
