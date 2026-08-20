/**
 * Document signing — the one part of this pipeline that CANNOT be
 * finished from here, and the file says so out loud rather than
 * pretending.
 *
 * WHAT ETA ACTUALLY REQUIRES AT GO-LIVE
 * -------------------------------------
 * Every production e-invoice carries a CAdES-BES detached signature
 * (`signatures[0].signatureType = "I"`) computed over the document's
 * canonical serialization with the taxpayer's e-seal: an X.509
 * certificate issued by an Egyptian licensed CA, held on a physical
 * HSM / USB cryptographic token, driven through PKCS#11. The private
 * key never leaves the token by design — that is the entire point of an
 * e-seal — which means:
 *
 *   * it cannot be a Worker secret, because there is no key material to
 *     put in a secret;
 *   * it cannot be done inside a Cloudflare Worker at all, because a
 *     Worker cannot hold a PKCS#11 session against a USB token;
 *   * the go-live shape is a small signing service that lives wherever
 *     the token is plugged in (the showroom's own machine, or a hosted
 *     HSM), which this module calls over HTTPS.
 *
 * That service is the ONLY thing missing between this file and a real
 * filing. Everything it needs is already produced here: the canonical
 * string (`canonicalize`) is exactly the input ETA specifies for the
 * signed attributes, so the signer receives a string and returns a
 * base64 CAdES-BES blob. `signViaCadesToken` below is the seam, and its
 * body is the honest one-line refusal rather than a stub that returns
 * something signature-shaped.
 *
 * WHAT THIS FILE DOES DO
 * ----------------------
 *   ETA_SIGNING_MODE=none      no signature. Permitted ONLY when
 *                              ETA_MODE=mock. The sandbox demo is not
 *                              claiming to have sealed anything.
 *   ETA_SIGNING_MODE=hmac-dev  a deterministic HMAC-SHA256 over the
 *                              canonical string using ETA_SIGNING_KEY,
 *                              prefixed DEV-HMAC-SHA256 so it can never
 *                              be mistaken for a CAdES blob by a human
 *                              or by a grep. Deterministic on purpose:
 *                              the same document signs to the same value
 *                              every time, which is what makes the demo
 *                              reproducible and the tests exact.
 *   ETA_SIGNING_MODE=cades-bes the real thing. Throws until the signing
 *                              service is configured.
 *
 * WORKERS COMPATIBILITY: WebCrypto (`crypto.subtle`) throughout, no
 * node:crypto, no Buffer. This runs unchanged on @opennextjs/cloudflare.
 *
 * No `import "server-only"` — see the note at the top of env.ts. The
 * server boundary in this directory is service.ts; this file is pure
 * enough to unit-test and is tested.
 */

import type { EtaDocument, EtaSigningMode, SignedDocument } from "./types";
import { getEtaMode } from "./env";

/**
 * ETA's canonical serialization, which is what gets signed.
 *
 * The rule, from the SDK's "Document Serialization" section: walk the
 * document in declaration order; for every property emit its name
 * uppercased in double quotes, then either recurse (object), or — for an
 * array — re-emit the property name once per element before recursing
 * into it, or emit the value in double quotes (scalar). `signatures` is
 * excluded, because a signature cannot cover itself.
 *
 * Two things this implementation is deliberate about:
 *
 *   * Property ORDER is the object's own insertion order. document.ts
 *     builds every object with its keys in the published schema's order
 *     and never spreads a partial over it, so the serialization is
 *     stable across runs and across Node versions (integer-like keys
 *     would reorder, and there are none).
 *   * `undefined` and absent keys are skipped rather than emitted as
 *     "undefined". document.ts omits optional keys entirely instead of
 *     setting them to undefined, so this is belt to that brace.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    // Reached only through the object branch below, which supplies the
    // repeated property name. A bare array has no name to repeat.
    return value.map((v) => canonicalize(v)).join("");
  }

  if (typeof value === "object") {
    let out = "";
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (key === "signatures") continue;
      const name = `"${key.toUpperCase()}"`;
      if (Array.isArray(v)) {
        for (const element of v) {
          out += name;
          out += canonicalize(element);
        }
      } else if (v !== null && typeof v === "object") {
        out += name;
        out += canonicalize(v);
      } else {
        out += name;
        out += `"${String(v)}"`;
      }
    }
    return out;
  }

  return `"${String(value)}"`;
}

/** Resolve the signing mode from the environment, defaulting per ETA_MODE. */
export function getSigningMode(): EtaSigningMode {
  const raw = (process.env.ETA_SIGNING_MODE ?? "").trim().toLowerCase();
  if (raw === "none" || raw === "hmac-dev" || raw === "cades-bes") return raw;
  if (raw !== "") {
    throw new Error(
      `ETA_SIGNING_MODE="${raw}" is not one of none | hmac-dev | cades-bes.`
    );
  }
  // Unset: the sandbox signs nothing, and anything that can reach the
  // real authority must say what it intends to sign with.
  return getEtaMode() === "mock" ? "none" : "cades-bes";
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  // btoa is present in Workers, Node 16+ and the browser alike.
  return btoa(binary);
}

async function hmacSign(canonical: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(canonical));
  return base64(signature);
}

/**
 * THE GO-LIVE SEAM.
 *
 * At go-live this posts `canonical` to the signing service that holds
 * the e-seal token and returns the base64 CAdES-BES blob it responds
 * with:
 *
 *   const res = await fetch(requiredEnv("ETA_SIGNER_URL"), {
 *     method: "POST",
 *     headers: {
 *       "content-type": "application/json",
 *       authorization: `Bearer ${requiredEnv("ETA_SIGNER_TOKEN")}`,
 *     },
 *     body: JSON.stringify({ canonical }),
 *   });
 *
 * It is not implemented because there is no token, no certificate and no
 * service to point it at, and a function that returned a plausible
 * base64 string here would produce documents that LOOK signed all the
 * way to the moment the authority rejects them — or worse, that a
 * reviewer believes were filed. The refusal is the honest behaviour.
 */
async function signViaCadesToken(canonical: string): Promise<string> {
  void canonical;
  const url = process.env.ETA_SIGNER_URL?.trim();
  throw new Error(
    url
      ? `CAdES-BES signing is not implemented in this build (ETA_SIGNER_URL=${url}). ` +
        "Implement signViaCadesToken() in src/lib/eta/signing.ts against the e-seal signing service."
      : "ETA signing token not configured. Production e-invoices require a CAdES-BES " +
        "signature from the taxpayer's e-seal certificate; set ETA_SIGNING_MODE=hmac-dev " +
        "for a development signature, or configure the signing service for go-live."
  );
}

/**
 * Sign a built document.
 *
 * Returns the document with `signatures` attached (empty in `none`
 * mode), the mode that produced it, and the canonical string that was
 * signed. The canonical string is kept because it is the only artifact
 * that makes an after-the-fact dispute answerable: "this is the exact
 * byte sequence the signature covers".
 */
export async function signDocument(document: EtaDocument): Promise<SignedDocument> {
  const mode = getSigningMode();
  const canonicalString = canonicalize(document);

  if (mode === "none") {
    if (getEtaMode() !== "mock") {
      throw new Error(
        'ETA_SIGNING_MODE=none is only permitted when ETA_MODE=mock. A submission to ' +
          "preprod or production must be signed."
      );
    }
    return { document: { ...document, signatures: [] }, signingMode: mode, canonicalString };
  }

  if (mode === "hmac-dev") {
    const key = process.env.ETA_SIGNING_KEY?.trim();
    if (!key) {
      throw new Error(
        "ETA_SIGNING_MODE=hmac-dev requires ETA_SIGNING_KEY — set it in .env.local (local) " +
          "and as a Worker secret (deployed)."
      );
    }
    if (getEtaMode() === "production") {
      throw new Error(
        "ETA_SIGNING_MODE=hmac-dev cannot be used with ETA_MODE=production. An HMAC is not " +
          "an e-seal and the authority will reject it; configure CAdES-BES signing."
      );
    }
    const value = `DEV-HMAC-SHA256:${await hmacSign(canonicalString, key)}`;
    return {
      document: { ...document, signatures: [{ signatureType: "I", value }] },
      signingMode: mode,
      canonicalString,
    };
  }

  const value = await signViaCadesToken(canonicalString);
  return {
    document: { ...document, signatures: [{ signatureType: "I", value }] },
    signingMode: mode,
    canonicalString,
  };
}
