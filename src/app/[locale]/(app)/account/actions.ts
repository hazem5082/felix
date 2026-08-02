"use server";

import { revalidatePath } from "next/cache";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { authenticate } from "@/lib/auth";
import { toUserError } from "@/lib/db-error";
import {
  ChangePasswordSchema,
  UpdateNotificationContactsSchema,
  parseInput,
} from "@/lib/validation";

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
