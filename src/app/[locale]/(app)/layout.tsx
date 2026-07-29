import { getProfile } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";
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
  const profile = await getProfile();

  if (!profile) {
    redirect({ href: "/login", locale });
  }

  return (
    <div className="flex h-screen">
      <Sidebar role={profile!.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar profile={profile!} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
