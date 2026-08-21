import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticate } from "@/lib/auth";
import { createSignedDownloadUrl } from "@/lib/r2";

/**
 * GET /api/mail/attachment/[id] — 302s to a 60-second signed R2 GET URL.
 *
 * Access is checked by literally reading the row through the caller's
 * own RLS-scoped session (mail_attachments_select), which is exactly
 * the same rule the message list and reading pane are already subject
 * to — there is no separate authorization logic here to drift out of
 * sync with the policy. A miss reads as 404 whether the id is wrong or
 * just not this caller's to see, so a probing request cannot tell the
 * two apart.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if (!auth.ok) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const supabase = await createClient();
  const { data: attachment } = await supabase
    .from("mail_attachments")
    .select("filename, r2_key")
    .eq("id", id)
    .maybeSingle();

  if (!attachment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = await createSignedDownloadUrl(
    "mail",
    (attachment as { r2_key: string }).r2_key,
    (attachment as { filename: string }).filename
  );
  return NextResponse.redirect(url);
}
