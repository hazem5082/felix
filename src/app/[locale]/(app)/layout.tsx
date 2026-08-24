import { getFeatureGrants, getProfile } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";
import { getTenant } from "@/lib/tenant";
import { getSessionTenant } from "@/lib/supabase/server";
import {
  currentDemoPersona,
  demoPersonas,
  getDemoStatus,
  isFlagshipDemo,
} from "@/lib/demo";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Topbar } from "@/components/layout/topbar";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { DemoSwitcher } from "@/components/demo/demo-switcher";
import { DemoOffNotice } from "@/components/demo/demo-off-notice";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // The grants come along on the same round trip as the profile: the
  // sidebar and the phone tab bar both need them, and fetching them
  // after the guard below would serialise two reads for no reason.
  // getFeatureGrants() resolves to [] for a signed-out session, so it is
  // safe to ask for before the redirect.
  const [profile, tenant, claim, grants] = await Promise.all([
    getProfile(),
    getTenant(),
    getSessionTenant(),
    getFeatureGrants(),
  ]);

  if (!profile) {
    redirect({ href: "/login", locale });
  }

  // A session is only valid on its own showroom's subdomain, and only
  // while that licence is active. Checked on every authenticated request,
  // not just at sign-in, so a licence suspended mid-session takes effect
  // on the next page view rather than whenever the cookie happens to
  // expire.
  //
  // The session's showroom now comes from its access token claim rather
  // than profiles.tenant_id, which 0011 removed — the schema a profile
  // row lives in IS its tenant.
  if (
    !tenant ||
    !claim ||
    claim.slug !== tenant.slug ||
    claim.schema !== tenant.schema_name ||
    tenant.status === "suspended"
  ) {
    redirect({ href: "/login", locale });
  }

  // ── Demo mode ───────────────────────────────────────────────
  //
  // Everything below is dead code for a licensed showroom: isFlagshipDemo()
  // is false, `demo` stays null, and the shell renders exactly as it did
  // before demo mode existed. That is the invariant — a client's app must
  // not read demo_status, must not render the switcher, and must not be
  // affected by anyone toggling the demo off.
  //
  // The kill switch is checked HERE rather than in each page so that a
  // demo switched off mid-session is enforced on the next navigation, the
  // same way the licence gate above works. Sessions already issued are
  // not revoked — the notice replaces the shell, which is enough to stop
  // a prospect browsing a half-reset dataset.
  const demo = isFlagshipDemo(tenant) ? await getDemoStatus() : null;
  if (demo && !demo.enabled) {
    return <DemoOffNotice offMessage={demo.offMessage} />;
  }
  const demoKey = demo ? await currentDemoPersona() : null;

  return (
    // A column wrapper so the demo bar can sit above the sidebar as well
    // as the content. With no bar the inner row fills the viewport exactly
    // as the old `flex h-screen` root did; `min-h-0` is what keeps <main>'s
    // own overflow-y-auto working inside a flex column.
    <div className="flex h-screen flex-col">
      {demo && (
        <DemoSwitcher locale={locale} personas={demoPersonas()} currentKey={demoKey} />
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar role={profile!.role} grants={grants} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar profile={profile!} showroomName={tenant!.name} />
          <Breadcrumbs />
          {/* pb-24 on mobile so the bottom tab bar never covers content. */}
          <main className="flex-1 overflow-y-auto p-6 pb-24 md:pb-6">{children}</main>
        </div>
      </div>
      <MobileNav role={profile!.role} grants={grants} />
    </div>
  );
}
