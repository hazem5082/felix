import "server-only";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Role } from "@/lib/supabase/types";

// Cloudflare R2 is S3-compatible. Credentials never leave the server —
// this module only ever hands the browser a short-lived presigned PUT URL.

export type UploadFolder =
  | "vehicles"
  | "financing-contracts"
  | "avatars"
  | "financing-requests"
  | "mail"
  | "branding";

/**
 * Who may write into each prefix. Previously any authenticated user — an
 * investor included — could presign into `financing-contracts`, the bucket
 * that gates whether a lender is considered active.
 */
export const FOLDER_ROLES: Record<UploadFolder, Role[]> = {
  vehicles: ["ceo", "branch_manager", "accountant"],
  "financing-contracts": ["ceo", "accountant"],
  "financing-requests": ["ceo", "accountant", "branch_manager", "sales_exec"],
  avatars: ["ceo", "accountant", "branch_manager", "sales_exec", "investor", "marketing"],
  // Mail is generic comms, unlike every other folder here — every role
  // that can sign in may attach a file to a message.
  mail: ["ceo", "accountant", "branch_manager", "sales_exec", "investor", "marketing"],
  // The company logo on every printed contract, report and sticker
  // (0046). CEO only — this is the letterhead the whole group signs
  // under, not a per-user asset.
  branding: ["ceo"],
};

/**
 * Folders whose bytes are personal, not marketing material. This module
 * never hands a caller a public URL for one, so nothing downstream can
 * store a mail attachment's address and treat it like a vehicle photo:
 * the only way to read one is createSignedDownloadUrl() or a server-side
 * GetObject, both behind the access check in
 * /api/mail/attachment/[id].
 *
 * THAT IS AN APPLICATION RULE, NOT A STORAGE ONE. These objects live in
 * the shared 508.world bucket alongside the public folders, and that
 * bucket is served in full by R2_PUBLIC_URL's r2.dev domain — r2.dev
 * public access is bucket-wide and cannot be scoped to a prefix. So a
 * key under mail/ IS fetchable by anyone holding it, without signing in.
 * What protects it is that the key is never published: it is a random
 * v4 UUID, it is returned only to the uploader, and mail_attachments.
 * r2_key is readable only by the message's sender and recipients under
 * RLS.
 *
 * To make it a storage rule again, set R2_MAIL_BUCKET_NAME to a bucket
 * with no public domain bound — bucketFor() prefers it when present and
 * nothing else has to change.
 */
const PRIVATE_FOLDERS = new Set<UploadFolder>(["mail"]);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not configured — set it in .env.local (local) and as a Worker secret/var (deployed).`
    );
  }
  return value;
}

function getClient() {
  const accountId = requiredEnv("R2_ACCOUNT_ID");
  const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function publicOrigin(): string {
  // Optional chaining here used to let a missing variable through as the
  // literal string "undefined/<key>", which then got persisted as a real
  // asset URL — and, for a bank contract, silently activated a lender.
  return requiredEnv("R2_PUBLIC_URL").replace(/\/$/, "");
}

/** Strips anything that could escape the prefix or truncate the URL. */
function safeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "file";
  return base.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
}

function bucketFor(folder: UploadFolder): string {
  // One bucket by default — the shared 508.world company bucket, where
  // each project owns a top-level prefix and mail/ is simply another
  // one. R2_MAIL_BUCKET_NAME stays as an opt-in override so a private
  // bucket can be introduced later without touching any call site; see
  // PRIVATE_FOLDERS for what that would buy.
  if (PRIVATE_FOLDERS.has(folder) && process.env.R2_MAIL_BUCKET_NAME) {
    return process.env.R2_MAIL_BUCKET_NAME;
  }
  return process.env.R2_BUCKET_NAME || "filex";
}

export async function createPresignedUpload(
  folder: UploadFolder,
  fileName: string,
  contentType: string,
  contentLength: number
) {
  const bucket = bucketFor(folder);
  const key = `${folder}/${crypto.randomUUID()}_${safeFileName(fileName)}`;

  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    // Signing the length binds the URL to the size the caller declared, so a
    // 15 MB grant cannot be redeemed for a 5 GB object.
    ContentLength: contentLength,
  });

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: 300,
    signableHeaders: new Set(["content-type", "content-length"]),
  });

  // No public URL for a private folder — see PRIVATE_FOLDERS. Handing one
  // back here would be a standing invitation for a caller to store it and
  // treat a mail attachment like a vehicle photo.
  const publicUrl = PRIVATE_FOLDERS.has(folder)
    ? null
    : `${publicOrigin()}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return { uploadUrl, publicUrl, key };
}

/**
 * Reads the first `maxBytes` of an already-uploaded object — enough to
 * run src/lib/file-sniff.ts's magic-byte check without downloading a
 * 25MB video to look at its first 512 bytes. Range reads are a normal
 * S3/R2 GetObject feature; a server that ignored the header would just
 * return the whole body; the caller is going to check content()
 * regardless.
 */
export async function readObjectPrefix(
  folder: UploadFolder,
  key: string,
  maxBytes: number
): Promise<Uint8Array> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: bucketFor(folder),
    Key: key,
    Range: `bytes=0-${maxBytes - 1}`,
  });
  const res = await client.send(command);
  const bytes = await res.Body?.transformToByteArray();
  return bytes ?? new Uint8Array();
}

/**
 * A direct, server-side write — used only by /api/mail/inbound, which
 * already holds the attachment bytes from the Worker's MIME parse and
 * has nothing for a browser to PUT against. Every other upload in this
 * module is a presigned PUT precisely to avoid routing large files
 * through a Next.js server; this is the one deliberate exception,
 * bounded by file-sniff.ts's MAX_ATTACHMENT_BYTES before it is ever
 * called.
 */
export async function putObject(
  folder: UploadFolder,
  fileName: string,
  bytes: Uint8Array,
  contentType: string
): Promise<{ key: string }> {
  const key = `${folder}/${crypto.randomUUID()}_${safeFileName(fileName)}`;
  const client = getClient();
  await client.send(
    new PutObjectCommand({ Bucket: bucketFor(folder), Key: key, Body: bytes, ContentType: contentType })
  );
  return { key };
}

/**
 * The whole object, base64-encoded — what the Worker's
 * POST /api/mail/felix/send actually needs to hand Resend an
 * attachment. Only ever called after readObjectPrefix() + sniff() have
 * already accepted the file, and only for messages small enough that
 * checkAttachmentBudget() let them reach an external recipient at all
 * (25MB total) — this is not a bulk-download path.
 */
export async function readObjectBase64(folder: UploadFolder, key: string): Promise<string> {
  const client = getClient();
  const res = await client.send(new GetObjectCommand({ Bucket: bucketFor(folder), Key: key }));
  const bytes = (await res.Body?.transformToByteArray()) ?? new Uint8Array();
  return Buffer.from(bytes).toString("base64");
}

/** Permanently removes an object — used to clean up an upload that failed the sniff check. */
export async function deleteObject(folder: UploadFolder, key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucketFor(folder), Key: key }));
}

/**
 * A short-lived signed GET URL for a private-folder object — the
 * attachment download route 302s the browser here after its own
 * RLS-equivalent access check. 60 seconds is generous for "click,
 * browser follows the redirect immediately" and useless to anyone who
 * captured the URL for later.
 *
 * DISPOSITION IS A SECURITY DECISION, WHICH IS WHY `inline` IS NOT A
 * PLAIN BOOLEAN A CALLER CAN JUST FLIP.
 *
 * Serving `attachment` is always safe: the browser saves the bytes and
 * renders nothing. Serving `inline` asks the browser to INTERPRET them,
 * which is only acceptable once something authoritative has said what
 * they are — an "attachment" that is really HTML must never render in a
 * tab, the same reasoning as the Agent Portal's mail.js route.
 *
 * So the inline variant cannot be constructed without a contentType, and
 * the one route that passes it gets that string from file-sniff.ts's own
 * read of the object's magic bytes — never from
 * mail_attachments.mime_type, which is whatever the uploading client
 * claimed (see that column's own comment) and therefore precisely the
 * value an attacker would choose.
 */
export type DownloadDisposition =
  | { inline: false }
  | { inline: true; contentType: string };

export async function createSignedDownloadUrl(
  folder: UploadFolder,
  key: string,
  downloadFilename: string,
  disposition: DownloadDisposition = { inline: false }
): Promise<string> {
  const client = getClient();
  const ascii = downloadFilename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "file";
  const shown = disposition.inline ? "inline" : "attachment";
  const command = new GetObjectCommand({
    Bucket: bucketFor(folder),
    Key: key,
    ResponseContentDisposition: `${shown}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`,
    // Only ever the sniffed type. R2 stores whatever content-type the
    // presigned PUT carried, which is the browser's guess from the
    // uploader's file extension; overriding it here makes the response
    // say what the bytes actually are.
    ...(disposition.inline ? { ResponseContentType: disposition.contentType } : {}),
  });
  return getSignedUrl(client, command, { expiresIn: 60 });
}

/**
 * True when `url` looks like something this application issued for `folder`.
 * Used to stop a hand-typed string standing in for an uploaded document.
 */
export function isManagedUploadUrl(url: string, folder: UploadFolder): boolean {
  let origin: string;
  try {
    origin = publicOrigin();
  } catch {
    return false;
  }
  if (!url.startsWith(`${origin}/`)) return false;

  const path = url.slice(origin.length + 1);
  // <folder>/<uuid>_<name>
  const pattern = new RegExp(
    `^${folder}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_.+$`,
    "i"
  );
  return pattern.test(decodeURIComponent(path));
}
