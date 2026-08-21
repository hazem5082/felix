/**
 * Attachment security for FELIX mail (migration 0039).
 *
 * "Check for file type" means the CONTENT, not the filename or the
 * browser's Content-Type header — both are attacker-controlled and
 * neither is checked here. Every caller (the compose path in
 * src/app/[locale]/(app)/mail/actions.ts and the inbound bridge in
 * src/app/api/mail/inbound/route.ts) must read the file's own first
 * bytes and pass them to `sniff()` before a mail_attachments row is
 * ever written. A mismatch is rejected outright — there is no
 * "trust the extension" fallback.
 *
 * WHY MAGIC BYTES AND NOT A LIBRARY
 * -----------------------------------
 * The allowlist is small and fixed (images, video, PDF, office docs,
 * text/CSV) and every signature below is a handful of bytes at a fixed
 * offset — exactly what every "detect file type" library does
 * internally, without taking on a dependency that parses the rest of
 * the file. OOXML (docx/xlsx/pptx) is the one soft spot: it is a ZIP
 * container, and confirming the PK signature only proves "this is SOME
 * zip", not "this is specifically a Word document". Full verification
 * would mean unzipping and reading `[Content_Types].xml`, which is more
 * than this allowlist needs — see `sniff()`'s own comment.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Messages with no external recipient never touch Resend/Cloudflare. */
export const MAX_TOTAL_BYTES_INTERNAL = 100 * 1024 * 1024;
/** Anything with an external recipient must survive a real SMTP hop. */
export const MAX_TOTAL_BYTES_EXTERNAL = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Bytes read from the front of a file before sniffing — enough for every signature below. */
export const SNIFF_PREFIX_BYTES = 512;

export type AttachmentKind =
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "pdf"
  | "mp4"
  | "mov"
  | "webm"
  | "docx"
  | "xlsx"
  | "pptx"
  | "txt"
  | "csv";

export const MIME_BY_KIND: Record<AttachmentKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
};

export type SniffResult =
  | { ok: true; kind: AttachmentKind; mimeType: string }
  | { ok: false; reason: string };

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function bytesEqual(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return bytesEqual(bytes, offset, Array.from(text, (c) => c.charCodeAt(0)));
}

const OOXML_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);

/**
 * True when `bytes` (a prefix of the file — SNIFF_PREFIX_BYTES is
 * plenty) looks like readable text rather than a renamed binary. Used
 * only for the txt/csv case, which has no magic number of its own: a
 * high proportion of control bytes outside common whitespace is what
 * every other signature check below would also reject, restated as a
 * positive test since there is nothing else to match against.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  let suspicious = 0;
  for (const b of bytes) {
    const isCommonWhitespace = b === 0x09 || b === 0x0a || b === 0x0d;
    if (!isCommonWhitespace && (b < 0x20 || b === 0x7f)) suspicious++;
  }
  // A handful of stray control bytes can appear in real text (a smart
  // quote decoded oddly, etc.); a binary file is overwhelmingly control
  // bytes. 2% is generous toward text and still refuses anything
  // JPEG/PNG/ZIP-shaped, which fail far higher than that.
  return suspicious / bytes.length < 0.02;
}

/**
 * Identifies `prefix` (the first SNIFF_PREFIX_BYTES of a file, or the
 * whole file if smaller) against the allowlist. `filename` is used only
 * to disambiguate cases the bytes alone cannot (OOXML's shared ZIP
 * signature; txt vs csv, which are bytewise identical) — never to
 * override what the bytes say.
 */
export function sniff(prefix: Uint8Array, filename: string): SniffResult {
  const ext = extensionOf(filename);

  if (bytesEqual(prefix, 0, [0xff, 0xd8, 0xff])) {
    return { ok: true, kind: "jpeg", mimeType: MIME_BY_KIND.jpeg };
  }
  if (bytesEqual(prefix, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ok: true, kind: "png", mimeType: MIME_BY_KIND.png };
  }
  if (asciiAt(prefix, 0, "GIF87a") || asciiAt(prefix, 0, "GIF89a")) {
    return { ok: true, kind: "gif", mimeType: MIME_BY_KIND.gif };
  }
  if (asciiAt(prefix, 0, "RIFF") && asciiAt(prefix, 8, "WEBP")) {
    return { ok: true, kind: "webp", mimeType: MIME_BY_KIND.webp };
  }
  if (asciiAt(prefix, 0, "%PDF-")) {
    return { ok: true, kind: "pdf", mimeType: MIME_BY_KIND.pdf };
  }
  if (bytesEqual(prefix, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { ok: true, kind: "webm", mimeType: MIME_BY_KIND.webm };
  }
  // ISO base media (mp4/mov both use it): a 4-byte size, then "ftyp".
  // The two are distinguished by extension — the box's own major-brand
  // field would be the byte-exact way, but mp4 and mov overlap there
  // too (a QuickTime-originated mp4 often carries "qt  " anyway), so
  // this allowlist treats them as one family and lets the filename say
  // which container the sender meant.
  if (asciiAt(prefix, 4, "ftyp")) {
    if (ext === "mov") return { ok: true, kind: "mov", mimeType: MIME_BY_KIND.mov };
    return { ok: true, kind: "mp4", mimeType: MIME_BY_KIND.mp4 };
  }
  // OOXML: a ZIP that claims to be one of the three Office formats.
  // This confirms the container, not the contents — see the file
  // header. Good enough to keep out a renamed .exe; not a substitute
  // for treating the file as untrusted once opened.
  if (bytesEqual(prefix, 0, [0x50, 0x4b, 0x03, 0x04]) && OOXML_EXTENSIONS.has(ext)) {
    const kind = ext as AttachmentKind;
    return { ok: true, kind, mimeType: MIME_BY_KIND[kind] };
  }
  if ((ext === "txt" || ext === "csv") && looksLikeText(prefix)) {
    const kind = ext as AttachmentKind;
    return { ok: true, kind, mimeType: MIME_BY_KIND[kind] };
  }

  return {
    ok: false,
    reason:
      bytesEqual(prefix, 0, [0x50, 0x4b, 0x03, 0x04])
        ? `"${filename}" is a zip-based file this allowlist does not accept as .${ext || "?"} — only .docx/.xlsx/.pptx are, and archives are not`
        : `"${filename}" does not match any allowed file type by its actual content`,
  };
}

/** Batch check for a compose or inbound message's whole attachment set. */
export function checkAttachmentBudget(
  sizes: number[],
  opts: { hasExternalRecipient: boolean }
): { ok: true } | { ok: false; reason: string } {
  if (sizes.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, reason: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message` };
  }
  const oversize = sizes.find((s) => s > MAX_ATTACHMENT_BYTES);
  if (oversize !== undefined) {
    return { ok: false, reason: `each attachment must be under ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB` };
  }
  const total = sizes.reduce((sum, s) => sum + s, 0);
  const cap = opts.hasExternalRecipient ? MAX_TOTAL_BYTES_EXTERNAL : MAX_TOTAL_BYTES_INTERNAL;
  if (total > cap) {
    return {
      ok: false,
      reason: `attachments total ${Math.round(total / (1024 * 1024))} MB — the limit is ${Math.round(cap / (1024 * 1024))} MB${opts.hasExternalRecipient ? " for a message leaving FELIX" : ""}`,
    };
  }
  return { ok: true };
}
