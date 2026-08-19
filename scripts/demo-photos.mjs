// Puts photographs on the four demo cars that are already on a showroom floor.
//
//   node --env-file=.env.local scripts/demo-photos.mjs
//   node --env-file=.env.local scripts/demo-photos.mjs --slug=clientb
//   node --env-file=.env.local scripts/demo-photos.mjs --upload-only
//
// Two steps, in order:
//
//   1. Upload scripts/demo-vehicles/*.jpg to R2 under vehicles/demo/ — fixed
//      keys, not the uuid-prefixed ones /api/upload mints, so re-running
//      overwrites in place instead of littering the bucket with copies.
//   2. Point the vehicles' `photos` / `inspection_photos` columns at them.
//
// SPLIT OUT FROM seed-demo.mjs DELIBERATELY. That script provisions a tenant,
// creates six auth accounts, and executes a sale through the real RPC; it
// needs SEED_PASSWORD and it does a great deal more than anyone wants when
// the only missing thing is pictures. This needs the service key and R2, it
// touches four rows, and it is safe to run against a showroom in use.
//
// NON-DESTRUCTIVE BY CONSTRUCTION. A column is only written when it is
// currently empty, so photographs someone uploaded through the intake form
// while demonstrating the product survive a re-run. Pass --force to overwrite
// them anyway; there is no way to get them back afterwards.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { PHOTO_FILES, r2KeyFor, photosFor, vinFor } from "./demo-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTERS = path.join(HERE, "demo-vehicles");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const SLUG = arg("slug", "felix").toLowerCase();
const SCHEMA = `t_${SLUG}`;
const FORCE = flag("force");
const UPLOAD_ONLY = flag("upload-only");

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ ${name} is not set. Run with --env-file=.env.local.`);
    process.exit(1);
  }
  return v;
}

const R2_PUBLIC_URL = required("R2_PUBLIC_URL");
const BUCKET = process.env.R2_BUCKET_NAME || "filex";

// ============================================================
// 1. R2
// ============================================================
async function uploadMasters() {
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });

  for (const file of PHOTO_FILES) {
    const body = await readFile(path.join(MASTERS, file));
    const key = r2KeyFor(file);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: "image/jpeg",
        // These never change once published and the key is stable, so a long
        // max-age costs nothing and keeps the grid off the network.
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
    console.log(`✓ ${key}  ${(body.length / 1024).toFixed(0)} KB`);
  }
}

/**
 * Proves the objects are actually readable at the public origin.
 *
 * An r2.dev bucket that has never had public access switched on accepts every
 * PUT and serves 401 on every GET, which would leave the demo looking exactly
 * as empty as before while the script reported ten successful uploads.
 */
async function verifyPublic() {
  const url = `${R2_PUBLIC_URL.replace(/\/$/, "")}/${r2KeyFor(PHOTO_FILES[0])}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `uploaded, but ${url} returns ${res.status}. The bucket's public r2.dev ` +
        `access is probably off — turn it on in the Cloudflare dashboard ` +
        `(R2 > ${BUCKET} > Settings > Public Development URL).`
    );
  }
  const type = res.headers.get("content-type");
  if (!type?.startsWith("image/")) {
    throw new Error(`${url} served "${type}" rather than an image.`);
  }
  console.log(`✓ public read OK (${type})`);
}

// ============================================================
// 2. The rows
// ============================================================
async function backfillRows() {
  const db = createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false }, db: { schema: SCHEMA } }
  );

  const photos = photosFor(R2_PUBLIC_URL);
  let touched = 0;

  for (const [key, want] of Object.entries(photos)) {
    const vin = vinFor(SLUG, key);
    const { data: row, error } = await db
      .from("vehicles")
      .select("id, year, make, model, photos, inspection_photos")
      .eq("vin", vin)
      .maybeSingle();

    if (error) throw new Error(`looking up ${key} (${vin}): ${error.message}`);
    if (!row) {
      console.log(`· ${key} (${vin}) is not on this showroom — skipping`);
      continue;
    }

    const patch = {};
    if (want.photos.length && (FORCE || !row.photos?.length)) patch.photos = want.photos;
    if (want.inspection_photos.length && (FORCE || !row.inspection_photos?.length))
      patch.inspection_photos = want.inspection_photos;

    const label = `${row.year} ${row.make} ${row.model}`;
    if (!Object.keys(patch).length) {
      console.log(`↷ ${label} already has photographs — left alone`);
      continue;
    }

    const { error: upErr } = await db.from("vehicles").update(patch).eq("id", row.id);
    if (upErr) throw new Error(`updating ${label}: ${upErr.message}`);
    console.log(`✓ ${label} — set ${Object.keys(patch).join(", ")}`);
    touched++;
  }

  console.log(`\n${touched} vehicle(s) updated on ${SCHEMA}.`);
  if (!FORCE && touched === 0) {
    console.log("Nothing to do. Re-run with --force to overwrite existing photographs.");
  }
}

console.log(`— demo photographs -> ${BUCKET}/vehicles/demo, showroom ${SLUG} —\n`);
await uploadMasters();
await verifyPublic();
if (UPLOAD_ONLY) {
  console.log("\n--upload-only: database left untouched.");
} else {
  console.log("");
  await backfillRows();
}
