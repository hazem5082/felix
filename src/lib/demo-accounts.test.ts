import { describe, expect, it } from "vitest";
import {
  DEMO_ACCOUNTS,
  DEMO_ACCOUNT_KEYS,
  DEMO_STATUS_MODULE_KEY,
  demoKeyForEmail,
  demoPersonas,
  isDemoAccountKey,
  isFlagshipDemo,
  parseDemoStatusRow,
} from "./demo-accounts";
import { FLAGSHIP_SLUG } from "./tenant-host";

describe("the demo persona allowlist", () => {
  it("matches the nine accounts scripts/seed-demo.mjs creates", () => {
    // If the seed's ACCOUNTS array changes, this is the test that says so.
    // Nothing derives one from the other at runtime, so drift here means
    // buttons that sign nobody in.
    expect(DEMO_ACCOUNT_KEYS).toEqual([
      "ceo",
      "manager",
      "manager2",
      "accountant",
      "sales",
      "marketing",
      "hr",
      "investor1",
      "investor2",
    ]);

    expect(DEMO_ACCOUNTS.ceo).toEqual({
      email: "ceo@filex.demo",
      role: "ceo",
      name: "Alex Carter",
    });
    expect(DEMO_ACCOUNTS.manager.role).toBe("branch_manager");
    expect(DEMO_ACCOUNTS.manager2.role).toBe("branch_manager");
    expect(DEMO_ACCOUNTS.accountant.role).toBe("accountant");
    expect(DEMO_ACCOUNTS.sales.role).toBe("sales_exec");
    expect(DEMO_ACCOUNTS.marketing.role).toBe("marketing");
    expect(DEMO_ACCOUNTS.hr.role).toBe("hr");
    expect(DEMO_ACCOUNTS.investor1.role).toBe("investor");
    expect(DEMO_ACCOUNTS.investor2.role).toBe("investor");
  });

  it("keeps every address inside the demo namespace, and distinct", () => {
    // auth.users is shared with A-Star and Calendar on one GoTrue
    // instance. An address here that is not under *.filex.demo could
    // collide with a real account on another product — and this table is
    // the only thing standing between the switch endpoint and that
    // address space.
    const emails = DEMO_ACCOUNT_KEYS.map((key) => DEMO_ACCOUNTS[key].email);
    for (const email of emails) {
      expect(email).toMatch(/^[a-z0-9]+@filex\.demo$/);
      expect(email).toBe(email.toLowerCase());
    }
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("accepts exactly the eight keys and nothing else", () => {
    for (const key of DEMO_ACCOUNT_KEYS) expect(isDemoAccountKey(key)).toBe(true);

    expect(isDemoAccountKey("admin")).toBe(false);
    expect(isDemoAccountKey("CEO")).toBe(false);
    expect(isDemoAccountKey("ceo ")).toBe(false);
    expect(isDemoAccountKey("")).toBe(false);
  });

  it("does not let prototype members pass as personas", () => {
    // The reason isDemoAccountKey uses hasOwnProperty rather than `in`:
    // `"constructor" in DEMO_ACCOUNTS` is true, and the switch action
    // would then index straight onto a function.
    expect(isDemoAccountKey("constructor")).toBe(false);
    expect(isDemoAccountKey("__proto__")).toBe(false);
    expect(isDemoAccountKey("toString")).toBe(false);
    expect(isDemoAccountKey("hasOwnProperty")).toBe(false);
  });

  it("refuses anything that is not a string", () => {
    // The key arrives over the wire from a Server Action call, so its
    // runtime type is whatever the caller sent.
    expect(isDemoAccountKey(null)).toBe(false);
    expect(isDemoAccountKey(undefined)).toBe(false);
    expect(isDemoAccountKey(0)).toBe(false);
    expect(isDemoAccountKey({ key: "ceo" })).toBe(false);
    expect(isDemoAccountKey(["ceo"])).toBe(false);
  });

  it("maps a signed-in address back to its persona, case-insensitively", () => {
    expect(demoKeyForEmail("investor2@filex.demo")).toBe("investor2");
    expect(demoKeyForEmail("  CEO@Filex.Demo  ")).toBe("ceo");
  });

  it("returns no persona for anyone who is not a demo account", () => {
    expect(demoKeyForEmail(null)).toBeNull();
    expect(demoKeyForEmail(undefined)).toBeNull();
    expect(demoKeyForEmail("")).toBeNull();
    expect(demoKeyForEmail("ceo@clientb.filex.demo")).toBeNull();
    expect(demoKeyForEmail("someone@508.world")).toBeNull();
  });

  it("hands the browser labels only, never addresses", () => {
    // demoPersonas() is what crosses into the Client Component. The email
    // map has to stay on the server side of that boundary.
    const personas = demoPersonas();
    expect(personas).toHaveLength(DEMO_ACCOUNT_KEYS.length);
    expect(personas.map((p) => p.key)).toEqual(DEMO_ACCOUNT_KEYS);
    expect(personas[0]).toEqual({ key: "ceo", name: "Alex Carter" });
    for (const persona of personas) {
      expect(Object.keys(persona).sort()).toEqual(["key", "name"]);
    }
  });
});

describe("isFlagshipDemo", () => {
  it("is true only for the flagship showroom", () => {
    expect(isFlagshipDemo({ slug: FLAGSHIP_SLUG })).toBe(true);
  });

  it("is false for every licensed client, which is the whole invariant", () => {
    // Every demo-mode check in the codebase starts with this call. If it
    // ever answered true for a paying showroom, that showroom could be
    // switched off by a row in a table it has nothing to do with.
    expect(isFlagshipDemo({ slug: "clientb" })).toBe(false);
    expect(isFlagshipDemo({ slug: "acmemotors" })).toBe(false);
    expect(isFlagshipDemo({ slug: "felixx" })).toBe(false);
    expect(isFlagshipDemo({ slug: "FELIX" })).toBe(false);
  });

  it("is false when there is no tenant at all", () => {
    expect(isFlagshipDemo(null)).toBe(false);
    expect(isFlagshipDemo(undefined)).toBe(false);
  });
});

describe("parseDemoStatusRow", () => {
  it("names the row the shared registry keys the demo under", () => {
    expect(DEMO_STATUS_MODULE_KEY).toBe("felix");
  });

  it("switches the demo off only for a row that says so explicitly", () => {
    expect(parseDemoStatusRow({ enabled: false })).toEqual({
      enabled: false,
      offMessage: null,
    });
    expect(parseDemoStatusRow({ enabled: false, off_message: "Resetting the seed data." })).toEqual({
      enabled: false,
      offMessage: "Resetting the seed data.",
    });
  });

  it("keeps the demo on for a row that says it is on", () => {
    expect(parseDemoStatusRow({ enabled: true })).toEqual({ enabled: true, offMessage: null });
    // An off_message left behind from a previous outage must not resurrect it.
    expect(parseDemoStatusRow({ enabled: true, off_message: "stale" })).toEqual({
      enabled: true,
      offMessage: null,
    });
  });

  it("fails OPEN when there is no row — the table may not exist yet", () => {
    // public.demo_status is created by a migration in another repository.
    // Until it lands, .maybeSingle() returns null, and the demo must keep
    // working: a missing migration bricking the product's shop window is
    // far worse than a kill switch that is briefly unavailable.
    expect(parseDemoStatusRow(null)).toEqual({ enabled: true, offMessage: null });
    expect(parseDemoStatusRow(undefined)).toEqual({ enabled: true, offMessage: null });
  });

  it("fails OPEN on any shape it does not recognise", () => {
    expect(parseDemoStatusRow({})).toEqual({ enabled: true, offMessage: null });
    expect(parseDemoStatusRow({ module_key: "felix" })).toEqual({
      enabled: true,
      offMessage: null,
    });
    // Anything ambiguous is treated as "nobody switched this off".
    expect(parseDemoStatusRow({ enabled: "false" })).toEqual({ enabled: true, offMessage: null });
    expect(parseDemoStatusRow({ enabled: 0 })).toEqual({ enabled: true, offMessage: null });
    expect(parseDemoStatusRow({ enabled: null })).toEqual({ enabled: true, offMessage: null });
    expect(parseDemoStatusRow("off")).toEqual({ enabled: true, offMessage: null });
    expect(parseDemoStatusRow(false)).toEqual({ enabled: true, offMessage: null });
  });

  it("treats a blank off_message as no message, so the notice falls back", () => {
    // The notice renders `offMessage ?? t("offBody")`. An empty or
    // whitespace-only cell would otherwise print nothing at all where the
    // explanation should be.
    expect(parseDemoStatusRow({ enabled: false, off_message: "" }).offMessage).toBeNull();
    expect(parseDemoStatusRow({ enabled: false, off_message: "   " }).offMessage).toBeNull();
    expect(parseDemoStatusRow({ enabled: false, off_message: null }).offMessage).toBeNull();
    expect(parseDemoStatusRow({ enabled: false, off_message: 42 }).offMessage).toBeNull();
    expect(parseDemoStatusRow({ enabled: false, off_message: "  Back at 14:00 UTC.  " }).offMessage).toBe(
      "Back at 14:00 UTC."
    );
  });
});
