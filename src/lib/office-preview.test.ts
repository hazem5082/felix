import { describe, it, expect } from "vitest";
import {
  columnIndex,
  decodeXmlText,
  docxParagraphs,
  sharedStrings,
  sheetRows,
  slideLines,
} from "./office-preview";

describe("decodeXmlText", () => {
  it("decodes the five XML named entities", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      `a & b <c> "d" 'e'`
    );
  });

  it("decodes decimal and hex character references", () => {
    expect(decodeXmlText("&#233;&#x627;")).toBe("éا");
  });

  it("leaves an unknown entity alone rather than eating it", () => {
    expect(decodeXmlText("100&nbsp;%")).toBe("100&nbsp;%");
  });
});

describe("columnIndex", () => {
  it("maps Excel's bijective base-26 column letters", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    // The case plain base-26 gets wrong: AA is 26, not 0.
    expect(columnIndex("AA1")).toBe(26);
    expect(columnIndex("BC12")).toBe(54);
  });
});

describe("docxParagraphs", () => {
  it("joins the runs inside one paragraph", () => {
    const xml = `<w:p><w:r><w:t>Dear </w:t></w:r><w:r><w:t xml:space="preserve">Morgan</w:t></w:r></w:p>`;
    expect(docxParagraphs(xml)).toEqual(["Dear Morgan"]);
  });

  it("keeps blank paragraphs between text, because that is the spacing", () => {
    const xml = `<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>Two</w:t></w:r></w:p>`;
    expect(docxParagraphs(xml)).toEqual(["One", "", "Two"]);
  });

  it("drops trailing blanks, which are the end of the file rather than content", () => {
    const xml = `<w:p><w:r><w:t>Only</w:t></w:r></w:p><w:p/><w:p/>`;
    expect(docxParagraphs(xml)).toEqual(["Only"]);
  });

  it("turns tabs and breaks into whitespace instead of dropping them", () => {
    const xml = `<w:p><w:r><w:t>a</w:t></w:r><w:tab/><w:r><w:t>b</w:t></w:r></w:p>`;
    expect(docxParagraphs(xml)).toEqual(["a\tb"]);
  });
});

describe("sharedStrings", () => {
  it("reads plain entries in index order", () => {
    expect(sharedStrings(`<sst><si><t>Alpha</t></si><si><t>Beta</t></si></sst>`)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("joins a string split across formatting runs", () => {
    const xml = `<sst><si><r><t>Total </t></r><r><t>EGP</t></r></si></sst>`;
    expect(sharedStrings(xml)).toEqual(["Total EGP"]);
  });
});

describe("sheetRows", () => {
  const strings = ["Vehicle", "Price"];

  it("resolves shared-string, inline and numeric cells", () => {
    const xml =
      `<sheetData>` +
      `<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
      `<row><c r="A2" t="inlineStr"><is><t>BMW 3</t></is></c><c r="B2"><v>1250000</v></c></row>` +
      `</sheetData>`;
    expect(sheetRows(xml, strings)).toEqual([
      ["Vehicle", "Price"],
      ["BMW 3", "1250000"],
    ]);
  });

  it("keeps a gap where a cell is absent, instead of shifting the row left", () => {
    // Sheet XML omits empty cells entirely — placing by element order
    // would put "third" under column A.
    const xml = `<sheetData><row><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData>`;
    expect(sheetRows(xml, strings)).toEqual([["1", "", "3"]]);
  });

  it("handles a self-closing empty cell", () => {
    const xml = `<sheetData><row><c r="A1"><v>1</v></c><c r="B1"/></row></sheetData>`;
    expect(sheetRows(xml, strings)).toEqual([["1", ""]]);
  });

  it("drops trailing empty rows", () => {
    const xml = `<sheetData><row><c r="A1"><v>1</v></c></row><row/><row/></sheetData>`;
    expect(sheetRows(xml, strings)).toEqual([["1"]]);
  });

  it("returns nothing for a sheet with no rows at all", () => {
    expect(sheetRows(`<sheetData/>`, strings)).toEqual([]);
  });
});

describe("slideLines", () => {
  it("collects each paragraph's text and skips empty ones", () => {
    const xml =
      `<p:sld><a:p><a:r><a:t>Q3 Results</a:t></a:r></a:p>` +
      `<a:p/>` +
      `<a:p><a:r><a:t>Revenue </a:t></a:r><a:r><a:t>up 12%</a:t></a:r></a:p></p:sld>`;
    expect(slideLines(xml)).toEqual(["Q3 Results", "Revenue up 12%"]);
  });
});
