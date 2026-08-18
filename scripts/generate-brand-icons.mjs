#!/usr/bin/env node
// One-off asset generator for FELIX's brand icons — tab icon + link
// previews. Run manually with `node scripts/generate-brand-icons.mjs`
// whenever public/brand/felix-logo.png changes; it is not part of the
// build.
//
// Source: public/brand/felix-logo.png — the serif "FELIX" wordmark, each
// letter filled with a galaxy/nebula texture, on a transparent background.
// This is the only brand asset that exists; there is no vector source, so
// every crop below works directly off that one 677×369 PNG.
//
// Outputs:
//   src/app/favicon.ico        — 16/32/48 PNG-in-ICO, replaces the Next.js
//                                 default triangle
//   src/app/icon.png           — 512×512, Next's file-convention app icon
//   src/app/apple-icon.png     — 180×180, Next's file-convention touch icon
//   src/app/opengraph-image.png / twitter-image.png
//                                — 1200×630 link-preview cards
//
// The favicon family shares one design: the leftmost letter ("F") cropped
// out of the wordmark, centered on a near-black rounded-square plate. The
// link-preview cards use the full wordmark instead, plus a tagline.

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_LOGO = path.join(ROOT, "public/brand/felix-logo.png");
const APP_DIR = path.join(ROOT, "src/app");

const PLATE_BG = "#0a0a0a";
const ALPHA_THRESHOLD = 10; // 0-255; anything above this counts as "ink"

// ---------------------------------------------------------------------
// Glyph geometry
// ---------------------------------------------------------------------

/**
 * Finds per-letter x-ranges and the shared vertical extent of a wordmark
 * image by scanning the raw alpha channel. All-caps wordmarks like FELIX
 * share one cap-height/baseline, so a single vertical extent is correct
 * for every letter, not just the whole word.
 */
async function analyzeGlyphs(buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const colHasInk = new Array(width).fill(false);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (data[(y * width + x) * channels + 3] > ALPHA_THRESHOLD) {
        colHasInk[x] = true;
        break;
      }
    }
  }

  const segments = [];
  let start = null;
  for (let x = 0; x < width; x++) {
    if (colHasInk[x] && start === null) start = x;
    if (!colHasInk[x] && start !== null) {
      segments.push([start, x - 1]);
      start = null;
    }
  }
  if (start !== null) segments.push([start, width - 1]);

  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] > ALPHA_THRESHOLD) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        break;
      }
    }
  }

  return { segments, minY, maxY, width, height };
}

/** Trims the wordmark's outer transparent margins, then locates the "F". */
async function extractFGlyph() {
  // Step 1 — trim the transparent margins off the whole wordmark first.
  const trimmed = await sharp(SRC_LOGO).trim({ threshold: ALPHA_THRESHOLD }).png().toBuffer();

  // Step 2 — within the trimmed word, the letters read left to right as
  // separate alpha segments (there's a transparent gap between each). The
  // first segment is the leftmost letter, "F".
  const { segments, minY, maxY } = await analyzeGlyphs(trimmed);
  if (segments.length < 5) {
    throw new Error(
      `Expected 5 letter segments in FELIX, found ${segments.length}. ` +
        `Column-alpha segmentation may need retuning (ALPHA_THRESHOLD=${ALPHA_THRESHOLD}).`
    );
  }
  const [fx0, fx1] = segments[0];
  const glyphWidth = fx1 - fx0 + 1;
  const glyphHeight = maxY - minY + 1;

  console.log(
    `[glyphs] letter x-ranges in trimmed wordmark: ${JSON.stringify(segments)} (row range ${minY}-${maxY})`
  );
  console.log(`[glyphs] "F" crop: x=${fx0}..${fx1} y=${minY}..${maxY} (${glyphWidth}x${glyphHeight})`);

  const fBuffer = await sharp(trimmed)
    .extract({ left: fx0, top: minY, width: glyphWidth, height: glyphHeight })
    .png()
    .toBuffer();

  return { fBuffer, glyphWidth, glyphHeight, trimmedWordmark: trimmed };
}

// ---------------------------------------------------------------------
// Square app icon: "F" on a near-black rounded-square plate
// ---------------------------------------------------------------------

/**
 * Builds the master square icon at `size`. The glyph is scaled to occupy
 * ~56% of the plate's height, leaving comfortable padding on every side —
 * more on the left/right than top/bottom, since "F" is narrower than it
 * is tall.
 */
async function buildAppIcon(fBuffer, glyphWidth, glyphHeight, size) {
  const targetHeight = Math.round(size * 0.56);
  const targetWidth = Math.round(targetHeight * (glyphWidth / glyphHeight));

  const resizedGlyph = await sharp(fBuffer)
    .resize({ width: targetWidth, height: targetHeight, fit: "fill" })
    .png()
    .toBuffer();

  const radius = Math.round(size * 0.22);
  const plateSvg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${PLATE_BG}"/>
  </svg>`;

  const left = Math.round((size - targetWidth) / 2);
  const top = Math.round((size - targetHeight) / 2);

  return sharp(Buffer.from(plateSvg))
    .composite([{ input: resizedGlyph, left, top }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------
// favicon.ico — hand-rolled PNG-in-ICO container
// ---------------------------------------------------------------------

function buildIco(entries) {
  // entries: [{ size, png: Buffer }]
  const HEADER_SIZE = 6;
  const DIR_ENTRY_SIZE = 16;
  let offset = HEADER_SIZE + DIR_ENTRY_SIZE * entries.length;

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dirEntries = [];
  const imageBlocks = [];
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(DIR_ENTRY_SIZE);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // color count: 0 = no palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // size of image data
    entry.writeUInt32LE(offset, 12); // offset of image data from file start
    dirEntries.push(entry);
    imageBlocks.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...imageBlocks]);
}

/** Reads an ICO file back and prints its directory table, for verification. */
function parseIco(buffer) {
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  console.log(`[favicon.ico] type=${type} (1=icon) entries=${count} totalBytes=${buffer.length}`);
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const width = buffer.readUInt8(off) || 256;
    const height = buffer.readUInt8(off + 1) || 256;
    const planes = buffer.readUInt16LE(off + 4);
    const bitCount = buffer.readUInt16LE(off + 6);
    const bytesInRes = buffer.readUInt32LE(off + 8);
    const imageOffset = buffer.readUInt32LE(off + 12);
    const pngSig = buffer.subarray(imageOffset, imageOffset + 8).toString("hex");
    const isPng = pngSig === "89504e470d0a1a0a";
    console.log(
      `  [${i}] ${width}x${height} planes=${planes} bitCount=${bitCount} bytes=${bytesInRes} ` +
        `offset=${imageOffset} pngSignatureOk=${isPng}`
    );
  }
}

// ---------------------------------------------------------------------
// Link-preview cards (opengraph-image.png / twitter-image.png)
// ---------------------------------------------------------------------

async function buildPreviewCard(trimmedWordmark) {
  const CARD_W = 1200;
  const CARD_H = 630;
  const TAGLINE = "Automotive showroom capital & deal management";

  const escapedTagline = TAGLINE.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const wordmarkMeta = await sharp(trimmedWordmark).metadata();
  const wordmarkTargetWidth = Math.round(CARD_W * 0.62); // comfortable side margins
  const wordmarkTargetHeight = Math.round(
    wordmarkTargetWidth * (wordmarkMeta.height / wordmarkMeta.width)
  );

  const resizedWordmark = await sharp(trimmedWordmark)
    .resize({ width: wordmarkTargetWidth, height: wordmarkTargetHeight, fit: "fill" })
    .png()
    .toBuffer();

  // Wordmark sits above center; the tagline goes underneath with its own
  // breathing room, and the whole block is vertically centered as a unit.
  const gap = 34;
  const taglineFontSize = 26;
  const blockHeight = wordmarkTargetHeight + gap + taglineFontSize;
  const blockTop = Math.round((CARD_H - blockHeight) / 2);

  const wordmarkLeft = Math.round((CARD_W - wordmarkTargetWidth) / 2);
  const wordmarkTop = blockTop;
  const taglineTop = wordmarkTop + wordmarkTargetHeight + gap;

  const backgroundSvg = `<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" fill="${PLATE_BG}"/>
  </svg>`;

  const taglineSvg = `<svg width="${CARD_W}" height="${taglineFontSize + 16}" xmlns="http://www.w3.org/2000/svg">
    <text x="50%" y="${taglineFontSize}" text-anchor="middle"
      font-family="Arial, Helvetica, sans-serif" font-size="${taglineFontSize}"
      font-weight="400" letter-spacing="0.5" fill="#a8a8ad">${escapedTagline}</text>
  </svg>`;

  return sharp(Buffer.from(backgroundSvg))
    .composite([
      { input: resizedWordmark, left: wordmarkLeft, top: wordmarkTop },
      { input: Buffer.from(taglineSvg), left: 0, top: taglineTop },
    ])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const { fBuffer, glyphWidth, glyphHeight, trimmedWordmark } = await extractFGlyph();

  // Master app icon at the largest size we need (512); every smaller
  // favicon size is downsampled from this master rather than re-upscaling
  // the low-resolution source glyph each time.
  const master512 = await buildAppIcon(fBuffer, glyphWidth, glyphHeight, 512);
  await writeFile(path.join(APP_DIR, "icon.png"), master512);
  console.log("[write] src/app/icon.png (512x512)");

  const apple180 = await sharp(master512).resize(180, 180).png().toBuffer();
  await writeFile(path.join(APP_DIR, "apple-icon.png"), apple180);
  console.log("[write] src/app/apple-icon.png (180x180)");

  const favSizes = [16, 32, 48];
  const favPngs = await Promise.all(
    favSizes.map((size) => sharp(master512).resize(size, size).png().toBuffer())
  );
  const icoBuffer = buildIco(favSizes.map((size, i) => ({ size, png: favPngs[i] })));
  await writeFile(path.join(APP_DIR, "favicon.ico"), icoBuffer);
  console.log(`[write] src/app/favicon.ico (${favSizes.join("/")}, ${icoBuffer.length} bytes)`);

  // Verify the ICO we just wrote by reading it back and parsing its
  // directory table (the .ico bytes themselves can't be visually Read).
  const writtenIco = await readFile(path.join(APP_DIR, "favicon.ico"));
  parseIco(writtenIco);

  const ogImage = await buildPreviewCard(trimmedWordmark);
  await writeFile(path.join(APP_DIR, "opengraph-image.png"), ogImage);
  console.log("[write] src/app/opengraph-image.png (1200x630)");
  await writeFile(path.join(APP_DIR, "twitter-image.png"), ogImage);
  console.log("[write] src/app/twitter-image.png (1200x630, same art)");

  console.log("\nDone. Visually verify the outputs (they're PNGs — read them back and look).");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
