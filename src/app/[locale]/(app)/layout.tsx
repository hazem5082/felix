import { getProfile } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";
import { getTenant } from "@/lib/tenant";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const [profile, tenant] = await Promise.all([getProfile(), getTenant()]);

  if (!profile) {
    redirect({ href: "/login", locale });
  }

  // A session is only valid on its own showroom's subdomain, and only
  // while that licence is active. Checked on every authenticated request,
  // not just at sign-in, so a licence suspended mid-session takes effect
  // on the next page view rather than whenever the cookie happens to
  // expire.
  if (!tenant || tenant.id !== profile!.tenant_id || tenant.status === "suspended") {
    redirect({ href: "/login", locale });
  }

  return (
    <div className="flex h-screen">
      <Sidebar role={profile!.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar profile={profile!} showroomName={tenant!.name} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
