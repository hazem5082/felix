"use server";

import { revalidatePath } from "next/cache";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { authenticate, authorize } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  ChangePasswordSchema,
  CompanySettingsSchema,
  UpdateNotificationContactsSchema,
  parseInput,
} from "@/lib/validation";
import { isManagedUploadUrl } from "@/lib/r2";

/**
 * Every signed-in role gets this page — it edits nothing but the
 * caller's own row, and `authenticate()` (not `authorize()`) is the
 * right gate for that. `profiles_update_self` (0003 §10) is the
 * enforcement layer: it scopes the write to `id = auth.uid()` (plus
 * the CEO), so `.eq("id", auth.profile.id)` here is belt-and-braces,
 * not the actual boundary.
 */
export async function updateNotificationContacts(input: {
  notification_email: string;
  whatsapp_number: string;
}) {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = parseInput(UpdateNotificationContactsSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      notification_email: parsed.data.notification_email,
      whatsapp_number: parsed.data.whatsapp_number,
    })
    .eq("id", auth.profile.id);

  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/account", "page");
  return { ok: true };
}

export async function changePassword(input: {
  current_password: string;
  new_password: string;
}) {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = parseInput(ChangePasswordSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Can't happen — authenticate() above already proved a session — but
  // the email has to come from the session, never from `profiles`
  // (which doesn't carry one), so this guards the lookup rather than
  // re-deriving trust.
  if (!user?.email) return { error: "Your session has expired. Please sign in again." };

  // A throwaway, unpersisted client: the only way to verify "is this
  // really their current password" is to attempt a real sign-in, and
  // doing that on the request's own server client would overwrite the
  // session cookie mid-request with whatever signInWithPassword
  // returns. persistSession: false keeps this check side-effect-free
  // even on failure.
  const verifier = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
  const { error: signInError } = await verifier.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.current_password,
  });
  if (signInError) return { error: "Your current password is incorrect." };

  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.new_password,
  });
  if (updateError) return { error: updateError.message };

  return { ok: true };
}


/**
 * Saves the company profile printed on every contract, report and
 * windshield sticker (migration 0046).
 *
 * CEO ONLY, in three independent places: authorize(["ceo"]) here, the
 * company_settings_insert/update policies in the database, and the
 * panel simply not rendering for anyone else. The policy is the one
 * that counts — a Server Action is a public endpoint whatever the UI
 * shows.
 *
 * UPSERT on the singleton column, because the tenant template is pure
 * DDL and cannot seed the row: it comes into being the first time this
 * runs. The unique constraint on  is what makes the upsert
 * target deterministic and a second row impossible.
 *
 * updated_by is set HERE rather than pinned by a policy predicate. That
 * is deliberate and 0046's header explains it: a policy naming
 * auth.uid() is evaluated as the tenant role, which has no USAGE on
 * schema auth, and would raise 42501 on every save — the exact bug 0045
 * had to repair in the price-history path.
 */
export async function updateCompanySettings(input: {
  legal_name: string;
  trade_name: string;
  logo_url: string;
  tax_id: string;
  commercial_registration: string;
  address: string;
  phone: string;
  email: string;
}) {
  const auth = await authorize(["ceo"]);
  if (!auth.ok) return auth.error;

  const parsed = parseInput(CompanySettingsSchema, input);
  if (!parsed.ok) return parsed.error;

  // A hand-typed URL here would put an arbitrary third-party image on
  // every contract this company issues — a phishing primitive and an
  // outbound request from the recipient's PDF viewer. Only a URL this
  // app actually issued for the CEO-only `branding` prefix is accepted.
  const logo = parsed.data.logo_url;
  if (logo && !isManagedUploadUrl(logo, "branding")) {
    return { error: "That logo was not uploaded through FELIX. Upload the file again." };
  }

  const blankToNull = (v: string) => (v.trim() ? v.trim() : null);

  const supabase = await createClient();
  const { error } = await supabase.from("company_settings").upsert(
    {
      singleton: true,
      legal_name: blankToNull(parsed.data.legal_name),
      trade_name: blankToNull(parsed.data.trade_name),
      logo_url: blankToNull(logo),
      tax_id: blankToNull(parsed.data.tax_id),
      commercial_registration: blankToNull(parsed.data.commercial_registration),
      address: blankToNull(parsed.data.address),
      phone: blankToNull(parsed.data.phone),
      email: blankToNull(parsed.data.email),
      updated_at: new Date().toISOString(),
      updated_by: auth.profile.id,
    },
    { onConflict: "singleton" }
  );
  if (error) return toUserError(error);

  revalidatePath("/[locale]/(app)/account", "page");
  return { ok: true };
}
