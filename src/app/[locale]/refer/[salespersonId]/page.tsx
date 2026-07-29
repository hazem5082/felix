import { ReferralForm } from "./referral-form";

export default async function ReferralPage({
  params,
}: {
  params: Promise<{ salespersonId: string }>;
}) {
  const { salespersonId } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <ReferralForm salespersonId={salespersonId} />
    </main>
  );
}
