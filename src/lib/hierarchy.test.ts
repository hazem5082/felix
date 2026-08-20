import { describe, expect, it } from "vitest";
import { ROLE_RANK, SUPERVISES, canAdministerAnyone, canChangeSignInEmail } from "./hierarchy";

const BRANCH_A = "branch-a";
const BRANCH_B = "branch-b";

const ceo = { id: "ceo-1", role: "ceo" as const, branch_id: null };
const managerA = { id: "mgr-a", role: "branch_manager" as const, branch_id: BRANCH_A };
const managerB = { id: "mgr-b", role: "branch_manager" as const, branch_id: BRANCH_B };
const salesA = { id: "sales-a", role: "sales_exec" as const, branch_id: BRANCH_A };
const salesB = { id: "sales-b", role: "sales_exec" as const, branch_id: BRANCH_B };
const marketingA = { id: "mkt-a", role: "marketing" as const, branch_id: BRANCH_A };
const accountant = { id: "acc-1", role: "accountant" as const, branch_id: null };
const investor = { id: "inv-1", role: "investor" as const, branch_id: null };

describe("canChangeSignInEmail — self", () => {
  it("lets everybody change their own address, whatever their role", () => {
    for (const p of [ceo, managerA, salesA, accountant, investor, marketingA]) {
      expect(canChangeSignInEmail(p, p)).toEqual({ allowed: true, reason: "self" });
    }
  });
});

describe("canChangeSignInEmail — the CEO", () => {
  it("may change anyone's, in any branch", () => {
    for (const t of [managerA, managerB, salesA, salesB, accountant, investor, marketingA]) {
      expect(canChangeSignInEmail(ceo, t).allowed).toBe(true);
    }
  });

  it("may change another CEO's — a group with a chairman and an MD", () => {
    const otherCeo = { id: "ceo-2", role: "ceo" as const, branch_id: null };
    expect(canChangeSignInEmail(ceo, otherCeo).allowed).toBe(true);
  });
});

describe("canChangeSignInEmail — a branch manager", () => {
  it("may change their own branch's sales and marketing staff", () => {
    expect(canChangeSignInEmail(managerA, salesA)).toEqual({ allowed: true, reason: "supervisor" });
    expect(canChangeSignInEmail(managerA, marketingA)).toEqual({
      allowed: true,
      reason: "supervisor",
    });
  });

  it("may NOT reach into another branch", () => {
    expect(canChangeSignInEmail(managerA, salesB)).toEqual({
      allowed: false,
      reason: "other_branch",
    });
  });

  it("MAY reach a branch they hold a 0030 grant on", () => {
    expect(canChangeSignInEmail(managerA, salesB, [BRANCH_B]).allowed).toBe(true);
  });

  it("may not take over a CEO account — the whole point of the rule", () => {
    expect(canChangeSignInEmail(managerA, ceo)).toEqual({
      allowed: false,
      reason: "not_supervised",
    });
  });

  it("may not change a peer manager's, even in their own branch", () => {
    const peer = { id: "mgr-a2", role: "branch_manager" as const, branch_id: BRANCH_A };
    expect(canChangeSignInEmail(managerA, peer)).toEqual({
      allowed: false,
      reason: "not_supervised",
    });
  });

  it("may not change the accountant's, who outranks nobody but reports to no branch", () => {
    expect(canChangeSignInEmail(managerA, accountant)).toEqual({
      allowed: false,
      reason: "not_supervised",
    });
    // And the reason is explicitly NOT a rank comparison: the accountant
    // ranks below a branch manager and is still out of reach.
    expect(ROLE_RANK.accountant).toBeLessThan(ROLE_RANK.branch_manager);
  });

  it("may not change an investor's", () => {
    expect(canChangeSignInEmail(managerA, investor).allowed).toBe(false);
  });
});

describe("canChangeSignInEmail — everyone else", () => {
  it("gives sales, marketing, accountants and investors authority over nobody", () => {
    for (const actor of [salesA, marketingA, accountant, investor]) {
      for (const target of [ceo, managerA, salesB, marketingA, accountant]) {
        if (actor.id === target.id) continue;
        expect(canChangeSignInEmail(actor, target).allowed).toBe(false);
      }
    }
  });

  it("does not let a salesperson change a colleague's on the same floor", () => {
    const peer = { id: "sales-a2", role: "sales_exec" as const, branch_id: BRANCH_A };
    expect(canChangeSignInEmail(salesA, peer)).toEqual({
      allowed: false,
      reason: "not_supervised",
    });
  });
});

describe("the supervision table itself", () => {
  it("names only the two roles that administer anyone", () => {
    expect(canAdministerAnyone("ceo")).toBe(true);
    expect(canAdministerAnyone("branch_manager")).toBe(true);
    expect(canAdministerAnyone("accountant")).toBe(false);
    expect(canAdministerAnyone("sales_exec")).toBe(false);
    expect(canAdministerAnyone("marketing")).toBe(false);
    expect(canAdministerAnyone("investor")).toBe(false);
  });

  it("never lets anyone but the CEO supervise a CEO", () => {
    for (const [role, supervised] of Object.entries(SUPERVISES)) {
      if (role === "ceo") continue;
      expect(supervised).not.toContain("ceo");
    }
  });
});
