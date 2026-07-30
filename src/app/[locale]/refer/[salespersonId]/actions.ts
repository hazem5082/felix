"use server";

import { createAdminClient } from "@/lib/supabase/admin";
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

  const admin = createAdminClient();

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
