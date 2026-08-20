import { describe, expect, it } from "vitest";
import {
  acceptsBranchGrants,
  canActOnBranchWithGrants,
  isOrgWide,
  selectableBranches,
} from "./branch-authority";

const HOME = "11111111-1111-1111-1111-111111111111";
const GRANTED = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

const BRANCHES = [
  { id: HOME, name: "Nasr City" },
  { id: GRANTED, name: "Heliopolis" },
  { id: OTHER, name: "Sheraton" },
];

describe("canActOnBranchWithGrants", () => {
  it("keeps the pre-0030 rule when nothing is granted", () => {
    expect(canActOnBranchWithGrants("branch_manager", HOME, HOME, [])).toBe(true);
    expect(canActOnBranchWithGrants("branch_manager", HOME, OTHER, [])).toBe(false);
    expect(canActOnBranchWithGrants("sales_exec", HOME, OTHER, [])).toBe(false);
  });

  it("extends a manager to a granted branch without moving their home", () => {
    expect(canActOnBranchWithGrants("branch_manager", HOME, GRANTED, [GRANTED])).toBe(true);
    expect(canActOnBranchWithGrants("branch_manager", HOME, HOME, [GRANTED])).toBe(true);
    expect(canActOnBranchWithGrants("branch_manager", HOME, OTHER, [GRANTED])).toBe(false);
  });

  it("is org-wide for the CEO and the accountant, granted or not", () => {
    for (const role of ["ceo", "accountant"] as const) {
      expect(canActOnBranchWithGrants(role, null, OTHER, [])).toBe(true);
      expect(canActOnBranchWithGrants(role, null, null, [])).toBe(true);
    }
  });

  // The null test 0009's header calls out: an unassigned profile must not
  // compare equal to a null branch_id and quietly widen its own scope.
  it("never lets a null branch match a null home branch", () => {
    expect(canActOnBranchWithGrants("sales_exec", null, null, [])).toBe(false);
    expect(canActOnBranchWithGrants("sales_exec", null, HOME, [])).toBe(false);
    expect(canActOnBranchWithGrants("sales_exec", null, GRANTED, [GRANTED])).toBe(true);
  });
});

describe("selectableBranches", () => {
  it("offers a branch manager only what the action will accept", () => {
    expect(selectableBranches("branch_manager", HOME, [GRANTED], BRANCHES).map((b) => b.name)).toEqual([
      "Nasr City",
      "Heliopolis",
    ]);
  });

  it("offers the whole list to org-wide roles, in the given order", () => {
    expect(selectableBranches("ceo", null, [], BRANCHES)).toEqual(BRANCHES);
  });

  it("offers nothing to an unassigned, ungranted profile", () => {
    expect(selectableBranches("sales_exec", null, [], BRANCHES)).toEqual([]);
  });
});

describe("role predicates", () => {
  it("names the org-wide roles and no others", () => {
    expect(isOrgWide("ceo")).toBe(true);
    expect(isOrgWide("accountant")).toBe(true);
    expect(isOrgWide("branch_manager")).toBe(false);
    expect(isOrgWide("sales_exec")).toBe(false);
    expect(isOrgWide("investor")).toBe(false);
  });

  it("accepts grants only for the two roles a branch means something to", () => {
    expect(acceptsBranchGrants("branch_manager")).toBe(true);
    expect(acceptsBranchGrants("sales_exec")).toBe(true);
    // Already org-wide, so a grant would say nothing.
    expect(acceptsBranchGrants("ceo")).toBe(false);
    expect(acceptsBranchGrants("accountant")).toBe(false);
    // Scoped by equity, not by branch.
    expect(acceptsBranchGrants("investor")).toBe(false);
  });
});
