/**
 * Enough of .docx / .xlsx / .pptx to SHOW somebody what is in the file
 * without making them download it and open Office.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY
 * An OOXML file is a zip of XML, and everything the reading pane needs —
 * the words in a document, the cells in a sheet, the text on the slides —
 * is a shallow read of one or two of those entries. A full renderer
 * (mammoth, SheetJS) would pull in a large dependency to reproduce layout
 * this preview does not show anyway, and the Office viewers from
 * Microsoft and Google are out of the question: both work by fetching the
 * file, which would mean handing a tenant's private correspondence to a
 * third party to look at.
 *
 * Zero dependencies. The zip reader below is short and the platform
 * already ships an inflater (`DecompressionStream`), so nothing new is
 * installed to read a format that is, at bottom, deflate plus XML.
 *
 * WHAT IT DELIBERATELY IS NOT
 * Not a renderer. No fonts, images, styles, merged cells, formulas,
 * charts, or slide layout — text and table structure only. It answers
 * "what does this say" and "is this the file I meant", which is what an
 * attachment preview is for. The Download button is right there for
 * anything more, and every caller falls back to it when this throws.
 */

export type OfficePreview =
  | { kind: "docx"; paragraphs: string[] }
  | { kind: "xlsx"; sheetName: string | null; rows: string[][] }
  | { kind: "pptx"; slides: string[][] };

/** Past this the preview is doing more scrolling than explaining. */
const MAX_DOC_PARAGRAPHS = 300;
const MAX_SHEET_ROWS = 200;
const MAX_SHEET_COLS = 40;
const MAX_SLIDES = 60;

// ── XML, read as text rather than parsed ─────────────────────────────
//
// DOMParser is not available in every runtime this module may be bundled
// for, and a preview wants the text nodes rather than a tree. Each regex
// below is scoped to one known-shape document, not to XML in general.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Concatenates every `<tag>…</tag>` text node, in document order. */
function textOf(xml: string, tag: string): string {
  const matches = xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"));
  let out = "";
  for (const m of matches) out += decodeXmlText(m[1]);
  return out;
}

/**
 * Word paragraphs. `<w:p>` is the paragraph and `<w:t>` the text runs
 * inside it; a paragraph with no runs is a blank line, which is worth
 * keeping because it is how the document was spaced.
 */
export function docxParagraphs(documentXml: string): string[] {
  const paragraphs: string[] = [];
  // Both spellings of a paragraph: `<w:p>…</w:p>` and the self-closing
  // `<w:p/>` Word writes for an empty line. Matching only the pair would
  // silently swallow every blank line in the document. `<w:pPr>` cannot
  // collide here — after `w:p` this needs whitespace, `>` or `/>`, and
  // `<w:pPr` offers none of them.
  for (const m of documentXml.matchAll(/<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    // Tabs and explicit breaks are structure, not markup — but they have
    // to be re-emitted INSIDE a text element, because textOf() reads the
    // contents of `<w:t>` and ignores everything between those elements.
    const body = (m[1] ?? "")
      .replace(/<w:tab\s*\/>/g, "<w:t>\t</w:t>")
      .replace(/<w:br\s*\/>/g, "<w:t>\n</w:t>");
    paragraphs.push(textOf(body, "w:t").trim());
    if (paragraphs.length >= MAX_DOC_PARAGRAPHS) break;
  }
  // Trailing blanks are the end of the file, not content.
  while (paragraphs.length && !paragraphs[paragraphs.length - 1]) paragraphs.pop();
  return paragraphs;
}

/** "BC12" -> 54. Excel's bijective base-26, not zero-indexed base-26. */
export function columnIndex(cellRef: string): number {
  const letters = /^([A-Z]+)/.exec(cellRef)?.[1];
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** `<si>` entries in index order — a `t="s"` cell holds an offset into these. */
export function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1], "t"));
  return out;
}

/**
 * One worksheet as a dense grid. Sheet XML is sparse — empty cells and
 * empty rows are simply absent — so cell references drive placement
 * rather than element order, or a row with a gap in it would shift left.
 */
export function sheetRows(sheetXml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(
      /<c\s([^>]*?)>([\s\S]*?)<\/c>|<c\s([^>]*?)\/>/g
    )) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
      const body = cellMatch[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
      let value: string;
      if (type === "s") {
        const idx = Number(textOf(body, "v"));
        value = strings[idx] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(body, "t");
      } else {
        value = textOf(body, "v");
      }
      const at = ref ? columnIndex(ref) : cells.length;
      if (at < MAX_SHEET_COLS) {
        while (cells.length < at) cells.push("");
        cells[at] = value;
      }
    }
    rows.push(cells);
    if (rows.length >= MAX_SHEET_ROWS) break;
  }
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  return rows;
}

/** Slide text. `<a:t>` is DrawingML's text run — titles, shapes, tables alike. */
export function slideLines(slideXml: string): string[] {
  const lines: string[] = [];
  for (const m of slideXml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
    const line = textOf(m[1], "a:t").trim();
    if (line) lines.push(line);
  }
  return lines;
}

// ── The smallest zip reader that reads an OOXML file ─────────────────

const decoder = new TextDecoder();

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Walks the End of Central Directory record back to each entry, which is
 * the only order that survives an archive whose entries were appended or
 * rewritten. Only the two compression methods OOXML actually uses are
 * handled: 0 (stored) and 8 (deflate); anything else is skipped rather
 * than guessed at, and shows up as a missing entry the caller falls back
 * on Download for.
 */
export async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let eocd = -1;
  const earliest = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // The local header repeats the name and extra fields at its OWN
    // lengths — the central directory's are not interchangeable.
    const localNameLength = view.getUint16(localAt + 26, true);
    const localExtraLength = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await inflateRaw(raw));

    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ── The one entry point the reading pane calls ───────────────────────

export async function previewOffice(
  buffer: ArrayBuffer,
  kind: "docx" | "xlsx" | "pptx"
): Promise<OfficePreview> {
  const files = await unzip(buffer);
  const read = (name: string) => {
    const entry = files.get(name);
    return entry ? decoder.decode(entry) : "";
  };

  if (kind === "docx") {
    return { kind, paragraphs: docxParagraphs(read("word/document.xml")) };
  }

  if (kind === "xlsx") {
    const strings = sharedStrings(read("xl/sharedStrings.xml"));
    // Sheet order lives in workbook.xml behind a relationship id; for a
    // preview the first worksheet by filename is the same sheet in every
    // file anyone actually sends, and costs no rels parsing to find.
    const first = [...files.keys()]
      .filter((n) => n.startsWith("xl/worksheets/") && n.endsWith(".xml"))
      .sort()[0];
    const name = /<sheet[^>]*name="([^"]+)"/.exec(read("xl/workbook.xml"))?.[1] ?? null;
    return {
      kind,
      sheetName: name ? decodeXmlText(name) : null,
      rows: first ? sheetRows(read(first), strings) : [],
    };
  }

  const slideNames = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]))
    .slice(0, MAX_SLIDES);
  return { kind, slides: slideNames.map((n) => slideLines(read(n))) };
}
