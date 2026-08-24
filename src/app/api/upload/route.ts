import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createPresignedUpload, FOLDER_ROLES } from "@/lib/r2";
import { MAX_UPLOAD_BYTES, PresignSchema } from "@/lib/validation";
import { consume, LIMITS, retryMessage } from "@/lib/rate-limit";

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Presigning is cheap for us and expensive for R2 — an unbounded loop from
  // one stale session could run up storage and egress with nothing able to
  // notice. Bucket per user rather than per IP: the caller is authenticated.
  const throttle = await consume(`upload:${profile.id}`, LIMITS.upload);
  if (!throttle.allowed) {
    return NextResponse.json(
      { error: await retryMessage(throttle.retryAfter) },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfter) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  const parsed = PresignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid upload request" },
      { status: 400 }
    );
  }

  const { folder, fileName, contentType, size } = parsed.data;

  // Each prefix carries its own authority — a bank contract is not the same
  // kind of object as a profile picture.
  if (!FOLDER_ROLES[folder].includes(profile.role)) {
    return NextResponse.json(
      { error: "You do not have permission to upload to this location." },
      { status: 403 }
    );
  }

  // PDFs belong to contracts and supporting documents; photo prefixes take
  // images only.
  if (contentType === "application/pdf" && folder === "vehicles") {
    return NextResponse.json({ error: "Vehicle photos must be images" }, { status: 400 });
  }
  if (contentType !== "application/pdf" && folder === "financing-contracts") {
    return NextResponse.json({ error: "Bank contracts must be PDF" }, { status: 400 });
  }

  // PresignSchema's own cap is the widest of any folder's (mail's 25MB) —
  // every other folder keeps its real, tighter limit here.
  if (folder !== "mail" && size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB` },
      { status: 400 }
    );
  }

  try {
    // Mail objects carry their uploader's id in the key (see
    // createPresignedUpload): sendMail() refuses a staged key whose owner
    // segment is not the caller, so a learned-or-guessed key from anyone
    // else — any other tenant on the shared bucket included — cannot be
    // attached to an outbound message and exfiltrated.
    const result = await createPresignedUpload(
      folder,
      fileName,
      contentType,
      size,
      folder === "mail" ? profile.id : undefined
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error("[upload] presign failed", { userId: profile.id, folder, err });
    return NextResponse.json({ error: "Failed to create upload URL" }, { status: 500 });
  }
}
