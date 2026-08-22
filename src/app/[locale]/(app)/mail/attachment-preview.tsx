"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, FileText, Loader2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { previewOffice, type OfficePreview } from "@/lib/office-preview";
import type { MailAttachment } from "@/lib/supabase/types";

/**
 * Shows an attachment instead of making somebody save it first.
 *
 * The renderer is chosen from the FILENAME, which is a display decision
 * and nothing more. What the browser is actually allowed to interpret is
 * decided server-side, where /api/mail/attachment/[id]?preview=1 re-reads
 * the object's magic bytes and only then serves it inline — so a file
 * lying about its extension gets the download disposition, the <img> or
 * <iframe> fails to render, and the viewer falls back to Download. The
 * name never grants anything.
 *
 * Images, PDFs and video are handed straight to the browser by URL.
 * Text and Office files are fetched instead, because there is nothing to
 * hand off: .txt/.csv want to be laid out rather than dumped, and no
 * browser renders .docx/.xlsx/.pptx at all (see office-preview.ts for
 * why that is unpacked here rather than shipped to a third-party viewer).
 */

type Renderer = "image" | "pdf" | "video" | "text" | "office" | "none";

const BY_EXTENSION: Record<string, Renderer> = {
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  pdf: "pdf",
  mp4: "video", mov: "video", webm: "video",
  txt: "text", csv: "text",
  docx: "office", xlsx: "office", pptx: "office",
};

/**
 * Fetched previews read the whole file into memory to parse it. Past
 * this it is faster to download the file than to watch a spinner, and
 * the tab pays for a copy of it either way.
 */
const MAX_FETCHED_BYTES = 8 * 1024 * 1024;

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function rendererFor(filename: string): Renderer {
  return BY_EXTENSION[extensionOf(filename)] ?? "none";
}

/** Splits one CSV line, honouring quoted fields containing commas. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

export function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: MailAttachment;
  onClose: () => void;
}) {
  const t = useTranslations("mail");
  const renderer = rendererFor(attachment.filename);
  const href = `/api/mail/attachment/${attachment.id}`;

  const [text, setText] = useState<string | null>(null);
  const [office, setOffice] = useState<OfficePreview | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  useEffect(() => {
    if (renderer !== "text" && renderer !== "office") return;
    if (attachment.size_bytes > MAX_FETCHED_BYTES) {
      setState("failed");
      return;
    }

    // Guards against a slow fetch resolving after the dialog has moved
    // on to a different attachment.
    let current = true;
    setState("loading");
    (async () => {
      try {
        const res = await fetch(href);
        if (!res.ok) throw new Error(String(res.status));
        if (renderer === "text") {
          const body = await res.text();
          if (current) { setText(body); setState("idle"); }
        } else {
          const buffer = await res.arrayBuffer();
          const kind = extensionOf(attachment.filename) as "docx" | "xlsx" | "pptx";
          const parsed = await previewOffice(buffer, kind);
          if (current) { setOffice(parsed); setState("idle"); }
        }
      } catch {
        // Never fatal: the dialog still offers Download.
        if (current) setState("failed");
      }
    })();
    return () => { current = false; };
  }, [href, renderer, attachment.filename, attachment.size_bytes]);

  const tooLarge = attachment.size_bytes > MAX_FETCHED_BYTES;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title={attachment.filename}>
        <div className="flex min-h-[18rem] flex-col gap-3">
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)]">
            {state === "loading" && (
              <p className="flex h-64 items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
                <Loader2 size={16} className="animate-spin" /> {t("previewLoading")}
              </p>
            )}

            {state === "failed" && (
              <p className="flex h-64 items-center justify-center px-6 text-center text-sm text-[var(--color-text-muted)]">
                {tooLarge ? t("previewTooLarge") : t("previewFailed")}
              </p>
            )}

            {state === "idle" && renderer === "image" && (
              // A signed 60-second R2 URL cannot be optimised by next/image,
              // which needs a stable remote pattern it is allowed to re-fetch
              // on its own schedule — this one expires before it could.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`${href}?preview=1`}
                alt={attachment.filename}
                className="mx-auto max-h-[70vh] w-auto max-w-full object-contain"
              />
            )}

            {state === "idle" && renderer === "pdf" && (
              // Same-origin URL, but it 302s to R2 — so the PDF renders in
              // the browser's own viewer on a different origin, with no
              // reach into this app's session.
              <iframe
                src={`${href}?preview=1`}
                title={attachment.filename}
                className="h-[70vh] w-full"
              />
            )}

            {state === "idle" && renderer === "video" && (
              <video src={`${href}?preview=1`} controls className="max-h-[70vh] w-full" />
            )}

            {state === "idle" && renderer === "text" && text !== null && (
              extensionOf(attachment.filename) === "csv" ? (
                <CsvTable body={text} />
              ) : (
                <pre className="overflow-auto p-4 text-xs leading-relaxed text-[var(--color-text)]">
                  {text}
                </pre>
              )
            )}

            {state === "idle" && renderer === "office" && office && (
              <OfficeBody preview={office} empty={t("previewNoText")} slideLabel={t("slide")} />
            )}

            {renderer === "none" && (
              <p className="flex h-64 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-[var(--color-text-muted)]">
                <FileText size={22} className="text-[var(--color-text-faint)]" />
                {t("previewUnavailable")}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-text-faint)]">
              {Math.ceil(attachment.size_bytes / 1024)} KB
            </p>
            <a
              href={href}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:bg-black/[0.03]"
            >
              <Download size={13} /> {t("download")}
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CsvTable({ body }: { body: string }) {
  const rows = body
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 200)
    .map(parseCsvLine);
  if (!rows.length) return null;
  return <Grid rows={rows} />;
}

function OfficeBody({
  preview,
  empty,
  slideLabel,
}: {
  preview: OfficePreview;
  empty: string;
  slideLabel: string;
}) {
  if (preview.kind === "docx") {
    if (!preview.paragraphs.length) return <Empty text={empty} />;
    return (
      <div className="space-y-2 p-4">
        {preview.paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text)]">
            {p || " "}
          </p>
        ))}
      </div>
    );
  }

  if (preview.kind === "xlsx") {
    if (!preview.rows.length) return <Empty text={empty} />;
    return (
      <div>
        {preview.sheetName && (
          <p className="border-b border-[var(--color-border)] px-4 py-2 text-xs font-medium text-[var(--color-text-muted)]">
            {preview.sheetName}
          </p>
        )}
        <Grid rows={preview.rows} />
      </div>
    );
  }

  const slides = preview.slides.filter((lines) => lines.length);
  if (!slides.length) return <Empty text={empty} />;
  return (
    <div className="divide-y divide-[var(--color-border)]">
      {slides.map((lines, i) => (
        <div key={i} className="p-4">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-[var(--color-text-faint)]">
            {slideLabel} {i + 1}
          </p>
          {lines.map((line, j) => (
            <p key={j} className="text-sm leading-relaxed text-[var(--color-text)]">{line}</p>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Shared by the .csv and .xlsx previews — same shape, same treatment. */
function Grid({ rows }: { rows: string[][] }) {
  const width = Math.max(...rows.map((r) => r.length));
  return (
    <table className="w-full border-collapse text-xs">
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={i === 0 ? "bg-black/[0.03]" : undefined}>
            {Array.from({ length: width }, (_, j) => (
              <td
                key={j}
                className="max-w-[16rem] truncate border border-[var(--color-border)] px-2 py-1 text-[var(--color-text)]"
                title={row[j] || undefined}
              >
                {row[j] ?? ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="flex h-64 items-center justify-center px-6 text-center text-sm text-[var(--color-text-muted)]">
      {text}
    </p>
  );
}
