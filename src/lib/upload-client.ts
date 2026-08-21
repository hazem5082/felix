"use client";

import type { UploadFolder } from "@/lib/r2";

/** Kept in step with MAX_UPLOAD_BYTES in @/lib/validation. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export async function uploadFile(file: File, folder: UploadFolder): Promise<string> {
  // Check locally too so a 40 MB photo fails instantly instead of after the
  // round trip. The server re-checks and signs the length regardless.
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      } MB.`
    );
  }

  const presignRes = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      folder,
      size: file.size,
    }),
  });

  if (!presignRes.ok) {
    const { error } = await presignRes.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(error || "Failed to get upload URL");
  }

  const { uploadUrl, publicUrl } = await presignRes.json();

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    // Content-Length is part of the signature, so the browser must send
    // exactly the size the server signed for.
    headers: { "Content-Type": file.type },
    body: file,
  });

  if (!putRes.ok) {
    throw new Error("Failed to upload file to storage");
  }

  return publicUrl as string;
}

export const MAX_MAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Mail's own upload path — the "mail" folder has no public URL (see
 * r2.ts's PRIVATE_FOLDERS), so this returns the R2 key instead, which
 * the compose action needs anyway to build the mail_attachments row.
 * The server re-reads and sniffs the bytes before the message can send
 * (src/lib/file-sniff.ts) — nothing here is a security check, only a
 * fast local size guard so a 40MB video fails before the round trip.
 */
export async function uploadMailAttachment(
  file: File
): Promise<{ key: string; filename: string; mimeType: string; sizeBytes: number }> {
  if (file.size > MAX_MAIL_ATTACHMENT_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${
        MAX_MAIL_ATTACHMENT_BYTES / 1024 / 1024
      } MB.`
    );
  }

  const presignRes = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      folder: "mail",
      size: file.size,
    }),
  });

  if (!presignRes.ok) {
    const { error } = await presignRes.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(error || "Failed to get upload URL");
  }

  const { uploadUrl, key } = await presignRes.json();

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!putRes.ok) throw new Error("Failed to upload file to storage");

  return { key, filename: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size };
}
