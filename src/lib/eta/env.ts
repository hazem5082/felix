/**
 * The ETA environment contract, in one place.
 *
 * NO `import "server-only"` HERE, and the omission is the same decision
 * tenant-host.ts and demo-accounts.ts document: that marker cannot be
 * resolved under vitest, and every module in `lib/eta` below service.ts
 * is unit-tested. The server boundary in this directory is service.ts —
 * it is the only file that touches next/cache, next/headers or a
 * Supabase client, it carries the marker, and nothing here is reachable
 * from the browser except through it. This file reads `process.env` and
 * nothing else.
 *
 * Read exactly the way `lib/r2.ts` reads its secrets — `process.env.X`
 * with a loud throw naming the variable and where it belongs — because
 * that is the shape @opennextjs/cloudflare populates from Worker
 * secrets and vars, and because a misconfigured showroom must fail with
 * a sentence rather than with `undefined` reaching the tax authority.
 *
 * NOTHING HERE HAS A NETWORK DEFAULT. The preprod base URLs are
 * documented below as COMMENTS and never as fallbacks: a default URL is
 * how a test suite, or a mis-set ETA_MODE, ends up making a request to
 * somebody's real endpoint. If a variable is needed and absent, the
 * caller gets an exception naming it.
 *
 * The documented ETA endpoints, for whoever fills in .env.local:
 *
 *   preprod    ETA_ID_BASE   https://id.preprod.eta.gov.eg
 *              ETA_API_BASE  https://api.preprod.invoicing.eta.gov.eg
 *   production ETA_ID_BASE   https://id.eta.gov.eg
 *              ETA_API_BASE  https://api.invoicing.eta.gov.eg
 *
 * (The SDK documentation at sdk.invoicing.eta.gov.eg is the authority
 * on these; they have moved between portal versions, which is the other
 * reason they are configuration and not constants.)
 */

import type { EtaMode } from "./types";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not configured — set it in .env.local (local) and as a Worker secret/var (deployed).`
    );
  }
  return value;
}

/**
 * Which authority this deployment talks to.
 *
 * Defaults to `mock`, and that default is load-bearing: a showroom that
 * has configured nothing gets the sandbox, sees the "Sandbox" badge on
 * every submission, and cannot accidentally file anything. Going live is
 * setting one variable — and then discovering, correctly, that the
 * credentials and the signing mode are also required.
 */
export function getEtaMode(): EtaMode {
  const raw = (process.env.ETA_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "mock") return "mock";
  if (raw === "preprod" || raw === "production") return raw;
  throw new Error(`ETA_MODE="${raw}" is not one of mock | preprod | production.`);
}

/** True when submissions are simulated in-process and file nothing. */
export function isSandbox(mode: EtaMode = getEtaMode()): boolean {
  return mode === "mock";
}

export interface EtaHttpConfig {
  idBase: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
}

export function getEtaHttpConfig(): EtaHttpConfig {
  return {
    idBase: requiredEnv("ETA_ID_BASE").replace(/\/$/, ""),
    apiBase: requiredEnv("ETA_API_BASE").replace(/\/$/, ""),
    clientId: requiredEnv("ETA_CLIENT_ID"),
    clientSecret: requiredEnv("ETA_CLIENT_SECRET"),
  };
}

/**
 * The taxpayer's ISIC activity code, as registered with ETA. Optional:
 * document.ts falls back to 4510 (sale of motor vehicles), which is
 * right for a showroom and wrong for anyone who registered under a
 * different activity.
 */
export function getEtaActivityCode(): string | undefined {
  return process.env.ETA_ACTIVITY_CODE?.trim() || undefined;
}

/**
 * The ETA-assigned branch code for the issuing premises.
 *
 * Optional, and the absence is warned about rather than blocked — see
 * `EtaIssuerConfig.branchCode` in document.ts for why there is no
 * column for this. "0" is what the portal assigns a single-branch
 * taxpayer's head office, and it is what the document falls back to.
 */
export function getEtaBranchCode(): string | undefined {
  return process.env.ETA_BRANCH_CODE?.trim() || undefined;
}

/**
 * How long the service waits for ETA to settle a submission before it
 * stops asking and leaves the row in `submitted`.
 *
 * Settlement is genuinely asynchronous — the authority accepts a
 * submission for processing and issues the per-document verdict after —
 * and this runs inside a Server Action, which is a request. So the poll
 * is short and bounded, and "still submitted" is a legitimate terminal
 * state for one request rather than a failure: the panel says so, and
 * the next refresh asks again.
 */
export function getEtaPollBudgetMs(): number {
  const raw = Number(process.env.ETA_POLL_BUDGET_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 20_000) : 6_000;
}
