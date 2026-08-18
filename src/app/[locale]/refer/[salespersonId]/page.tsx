import { getTenant } from "@/lib/tenant";
import { getDemoStatus, isFlagshipDemo } from "@/lib/demo";
import { DemoOffNotice } from "@/components/demo/demo-off-notice";
import { ReferralForm } from "./referral-form";

export default async function ReferralPage({
  params,
}: {
  params: Promise<{ salespersonId: string }>;
}) {
  const { salespersonId } = await params;

  // The only unauthenticated page in the product, and therefore the only
  // one the (app) layout's demo gate cannot reach. A referral link handed
  // out during a demo keeps working long after the demo tab is closed, so
  // it needs the notice as much as the shell does.
  //
  // Licensed showrooms: isFlagshipDemo() is false, `demo` stays null, and
  // the page renders exactly as before.
  const tenant = await getTenant();
  const demo = isFlagshipDemo(tenant) ? await getDemoStatus() : null;
  if (demo && !demo.enabled) {
    return <DemoOffNotice offMessage={demo.offMessage} />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <ReferralForm salespersonId={salespersonId} />
    </main>
  );
}
