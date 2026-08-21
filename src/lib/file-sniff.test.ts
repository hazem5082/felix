import { describe, expect, it } from "vitest";
import { checkAttachmentBudget, MAX_ATTACHMENT_BYTES, sniff } from "./file-sniff";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

describe("sniff", () => {
  it("accepts a real JPEG", () => {
    const r = sniff(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0), "photo.jpg");
    expect(r).toMatchObject({ ok: true, kind: "jpeg" });
  });

  it("accepts a real PNG", () => {
    const r = sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "photo.png");
    expect(r).toMatchObject({ ok: true, kind: "png" });
  });

  it("accepts GIF87a and GIF89a", () => {
    expect(sniff(new Uint8Array(ascii("GIF87a")), "a.gif")).toMatchObject({ ok: true, kind: "gif" });
    expect(sniff(new Uint8Array(ascii("GIF89a")), "a.gif")).toMatchObject({ ok: true, kind: "gif" });
  });

  it("accepts WEBP via the RIFF....WEBP frame", () => {
    const buf = new Uint8Array(12);
    buf.set(ascii("RIFF"), 0);
    buf.set(ascii("WEBP"), 8);
    expect(sniff(buf, "a.webp")).toMatchObject({ ok: true, kind: "webp" });
  });

  it("accepts a real PDF", () => {
    expect(sniff(new Uint8Array(ascii("%PDF-1.7")), "doc.pdf")).toMatchObject({ ok: true, kind: "pdf" });
  });

  it("accepts WEBM via the EBML header", () => {
    expect(sniff(bytes(0x1a, 0x45, 0xdf, 0xa3), "clip.webm")).toMatchObject({ ok: true, kind: "webm" });
  });

  it("accepts an ftyp box as mp4 or mov by extension", () => {
    const buf = new Uint8Array(12);
    buf.set([0, 0, 0, 0x18], 0);
    buf.set(ascii("ftyp"), 4);
    expect(sniff(buf, "clip.mp4")).toMatchObject({ ok: true, kind: "mp4" });
    expect(sniff(buf, "clip.mov")).toMatchObject({ ok: true, kind: "mov" });
  });

  it("accepts a PK zip as docx/xlsx/pptx only when the extension names one", () => {
    const buf = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);
    expect(sniff(buf, "report.docx")).toMatchObject({ ok: true, kind: "docx" });
    expect(sniff(buf, "sheet.xlsx")).toMatchObject({ ok: true, kind: "xlsx" });
    expect(sniff(buf, "deck.pptx")).toMatchObject({ ok: true, kind: "pptx" });
  });

  it("refuses a zip renamed to an extension outside the OOXML three — no archive smuggling", () => {
    const buf = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);
    const r = sniff(buf, "bundle.zip");
    expect(r.ok).toBe(false);
  });

  it("accepts plain text as txt or csv", () => {
    const text = new Uint8Array(ascii("name,email\nAlex,alex@example.com\n"));
    expect(sniff(text, "list.csv")).toMatchObject({ ok: true, kind: "csv" });
    expect(sniff(text, "notes.txt")).toMatchObject({ ok: true, kind: "txt" });
  });

  it("refuses a renamed binary claiming to be text — the actual attack this exists to stop", () => {
    // An executable's real header (MZ...), renamed to report.txt.
    const exe = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00);
    const r = sniff(exe, "report.txt");
    expect(r.ok).toBe(false);
  });

  it("refuses a file whose bytes match nothing and whose extension is not text", () => {
    const r = sniff(bytes(1, 2, 3, 4, 5), "mystery.bin");
    expect(r.ok).toBe(false);
  });

  it("does not trust a JPEG's magic bytes on a mismatched extension claim — kind is read from content, not the name", () => {
    // The point: whatever the caller named it, a real JPEG is reported
    // as a JPEG, never silently coerced to match the (wrong) extension.
    const r = sniff(bytes(0xff, 0xd8, 0xff, 0xe0), "not-a-photo.exe");
    expect(r).toMatchObject({ ok: true, kind: "jpeg" });
  });
});

describe("checkAttachmentBudget", () => {
  it("passes a normal small internal message", () => {
    expect(checkAttachmentBudget([1_000, 2_000], { hasExternalRecipient: false })).toEqual({ ok: true });
  });

  it("refuses more than the per-message attachment count", () => {
    const r = checkAttachmentBudget(new Array(11).fill(10), { hasExternalRecipient: false });
    expect(r.ok).toBe(false);
  });

  it("refuses a single file over the per-file cap", () => {
    const r = checkAttachmentBudget([MAX_ATTACHMENT_BYTES + 1], { hasExternalRecipient: false });
    expect(r.ok).toBe(false);
  });

  it("allows a larger total for internal-only mail than for mail touching an external recipient", () => {
    // Four 10MB files: each under the per-file cap, 40MB combined —
    // over the 25MB external cap, under the 100MB internal one.
    const sizes = new Array(4).fill(10 * 1024 * 1024);
    expect(checkAttachmentBudget(sizes, { hasExternalRecipient: false })).toEqual({ ok: true });
    const r = checkAttachmentBudget(sizes, { hasExternalRecipient: true });
    expect(r.ok).toBe(false);
  });
});
