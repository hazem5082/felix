import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authenticate } from "@/lib/auth";
import { createSignedDownloadUrl, readObjectPrefix } from "@/lib/r2";
import { MIME_BY_KIND, SNIFF_PREFIX_BYTES, sniff, isPreviewable } from "@/lib/file-sniff";

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
 *
 * ?preview=1 asks for the bytes INLINE so the reading pane can show the
 * file instead of making somebody save it first. That is a different
 * risk than a download, and the difference is handled here rather than
 * being passed through:
 *
 *   - The content type is re-derived from the object's own magic bytes
 *     (a 512-byte ranged read, the same sniff the upload and inbound
 *     paths already run). mail_attachments.mime_type is NOT used — it is
 *     whatever the uploading client claimed, and inline rendering is
 *     exactly where a lie about it would pay off.
 *   - Only kinds a browser can safely display are allowed inline. The
 *     sniff allowlist has never contained HTML or SVG, so the dangerous
 *     cases cannot be stored in the first place; isPreviewable() is the
 *     second lock rather than the only one.
 *   - Anything that fails either test still downloads. A preview request
 *     degrades, it never errors — the reading pane offers Download for
 *     the same file either way.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const { filename, r2_key } = attachment as { filename: string; r2_key: string };

  const wantsPreview = new URL(request.url).searchParams.get("preview") === "1";

  if (wantsPreview) {
    const prefix = await readObjectPrefix("mail", r2_key, SNIFF_PREFIX_BYTES);
    const result = sniff(prefix, filename);
    if (result.ok && isPreviewable(result.kind)) {
      return NextResponse.redirect(
        await createSignedDownloadUrl("mail", r2_key, filename, {
          inline: true,
          contentType: MIME_BY_KIND[result.kind],
        })
      );
    }
    // Falls through to the download path on purpose — see the header.
  }

  return NextResponse.redirect(await createSignedDownloadUrl("mail", r2_key, filename));
}
