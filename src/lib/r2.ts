import "server-only";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Role } from "@/lib/supabase/types";

// Cloudflare R2 is S3-compatible. Credentials never leave the server —
// this module only ever hands the browser a short-lived presigned PUT URL.

export type UploadFolder =
  | "vehicles"
  | "financing-contracts"
  | "avatars"
  | "financing-requests";

/**
 * Who may write into each prefix. Previously any authenticated user — an
 * investor included — could presign into `financing-contracts`, the bucket
 * that gates whether a lender is considered active.
 */
export const FOLDER_ROLES: Record<UploadFolder, Role[]> = {
  vehicles: ["ceo", "branch_manager", "accountant"],
  "financing-contracts": ["ceo", "accountant"],
  "financing-requests": ["ceo", "accountant", "branch_manager", "sales_exec"],
  avatars: ["ceo", "accountant", "branch_manager", "sales_exec", "investor"],
};

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

export async function createPresignedUpload(
  folder: UploadFolder,
  fileName: string,
  contentType: string,
  contentLength: number
) {
  const bucket = process.env.R2_BUCKET_NAME || "filex";
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

  const publicUrl = `${publicOrigin()}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  return { uploadUrl, publicUrl, key };
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
