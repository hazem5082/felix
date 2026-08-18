"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getTenant } from "@/lib/tenant";
import { getDemoStatus, isFlagshipDemo } from "@/lib/demo";
import { PublicLeadSchema, Uuid } from "@/lib/validation";
import { clientIp, consume, LIMITS, retryMessage } from "@/lib/rate-limit";

// This is the only unauthenticated write path in the system, and it runs on
// the service-role client, which bypasses RLS entirely. Everything here is
// about making that safe: bounded input, a throttle, and a response that
// does not reveal whether a given id belongs to a real salesperson.

const GENERIC_FAILURE = {
  error: "Something went wrong submitting your info. Please try again.",
};

export async function submitPublicLead(
  salespersonId: string,
  formData: FormData
): Promise<{ error: string } | { ok: true }> {
  const ip = await clientIp();
  const throttle = await consume(`public-lead:${ip}`, LIMITS.publicLead);
  if (!throttle.allowed) {
    return { error: `Too many submissions. ${retryMessage(throttle.retryAfter)}` };
  }

  const id = Uuid.safeParse(salespersonId);
  if (!id.success) return GENERIC_FAILURE;

  const parsed = PublicLeadSchema.safeParse({
    client_name: formData.get("client_name"),
    phone_number: formData.get("phone_number"),
    car_interest: formData.get("car_interest") || undefined,
    contact_time_preference: formData.get("contact_time_preference") || undefined,
    client_notes: formData.get("client_notes") || undefined,
  });

  if (!parsed.success) {
    return { error: "Please fill in your name and phone number correctly." };
  }

  // THE ONE PLACE THE HOSTNAME LEGITIMATELY PICKS THE SCHEMA.
  //
  // Everywhere else the schema comes from the session's access-token
  // claim, because the hostname is attacker-supplied (see lib/tenant.ts).
  // Here there is no session at all — that is the point of the referral
  // link — so the host is the only signal there is.
  //
  // It is safe here in a way it would not be elsewhere. The hostname does
  // not grant access; it selects which showroom this submission is FOR.
  // Getting it wrong cannot read anything: the salesperson lookup below
  // runs in the chosen schema, so an id belonging to a different showroom
  // simply is not found and the request fails exactly like an unknown
  // link. The worst a forged Host achieves is offering to create a lead
  // in a showroom the submitter already had a public link to.
  const tenant = await getTenant();
  if (!tenant || tenant.status === "suspended") return GENERIC_FAILURE;

  // The flagship demo's kill switch. The page above already shows a notice
  // instead of the form, but this action is reachable by direct POST, and
  // "the demo is off" has to mean no writes into the seed dataset — a
  // reset that races a stray submission is exactly the mess the switch
  // exists to prevent.
  //
  // Unlike the failures above, this one is not an oracle for anything: the
  // demo's status is already public to anyone who loads the page, so the
  // operator's own message is passed straight through. English literals
  // here match the rest of this file — it has no locale to translate with,
  // and the translated notice is on the page.
  const demo = isFlagshipDemo(tenant) ? await getDemoStatus() : null;
  if (demo && !demo.enabled) {
    return { error: demo.offMessage ?? "This demo is currently off." };
  }

  const admin = createAdminClient(tenant.schema_name);

  const { data: salesperson } = await admin
    .from("profiles")
    .select("id, branch_id, role")
    .eq("id", id.data)
    .maybeSingle();

  const s = salesperson as { id: string; branch_id: string | null; role: string } | null;

  // A distinct "no longer valid" message turned this into an oracle for
  // enumerating live sales_exec ids, so an unknown link now fails the same
  // way a database error does.
  if (!s || s.role !== "sales_exec") return GENERIC_FAILURE;

  const { error } = await admin.from("leads").insert({
    ...parsed.data,
    salesperson_id: s.id,
    branch_id: s.branch_id,
    source: "link",
  });

  if (error) {
    console.error("[public-lead] insert failed", { salespersonId: s.id, error });
    return GENERIC_FAILURE;
  }
  return { ok: true };
}
