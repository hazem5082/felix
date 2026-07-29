import "server-only";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Cloudflare R2 is S3-compatible. Credentials never leave the server —
// the old app's build had these exposed in the client bundle; this
// route only ever returns a short-lived presigned PUT URL.
function getClient() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 credentials are not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env.local"
    );
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export type UploadFolder =
  | "vehicles"
  | "financing-contracts"
  | "avatars"
  | "financing-requests";

export async function createPresignedUpload(
  folder: UploadFolder,
  fileName: string,
  contentType: string
) {
  const bucket = process.env.R2_BUCKET_NAME || "filex";
  const key = `${folder}/${crypto.randomUUID()}_${fileName.replace(/\s+/g, "_")}`;

  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });
  const publicUrl = `${process.env.R2_PUBLIC_URL?.replace(/\/$/, "")}/${key}`;

  return { uploadUrl, publicUrl, key };
}
