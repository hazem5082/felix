"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

const PublicLeadSchema = z.object({
  client_name: z.string().min(2),
  phone_number: z.string().min(6),
  car_interest: z.string().optional(),
  contact_time_preference: z.string().optional(),
  client_notes: z.string().optional(),
});

export async function submitPublicLead(salespersonId: string, formData: FormData) {
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
    .eq("id", salespersonId)
    .single();

  if (!salesperson || (salesperson as { role: string }).role !== "sales_exec") {
    return { error: "This referral link is no longer valid." };
  }

  const { error } = await admin.from("leads").insert({
    ...parsed.data,
    salesperson_id: salespersonId,
    branch_id: (salesperson as { branch_id: string | null }).branch_id,
    source: "link",
  });

  if (error) return { error: "Something went wrong submitting your info. Please try again." };
  return { ok: true };
}
