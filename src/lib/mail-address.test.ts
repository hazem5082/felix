import { describe, expect, it } from "vitest";
import { FELIX_MAIL_DOMAIN, isFelixMailAddress } from "./mail-address";

describe("isFelixMailAddress", () => {
  it("recognises a FELIX address", () => {
    expect(isFelixMailAddress(`alex.carter.demo@${FELIX_MAIL_DOMAIN}`)).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(isFelixMailAddress("  Alex.Carter.Demo@FelixMail.508.World  ")).toBe(true);
  });

  it("catches another showroom's address, which is the case that matters", () => {
    // The reason the check exists: this is not the caller's colleague,
    // and relaying it would open a tenant-to-tenant mail channel.
    expect(isFelixMailAddress("sara.hany.northgate@felixmail.508.world")).toBe(true);
  });

  it("leaves genuinely external addresses alone", () => {
    expect(isFelixMailAddress("customer@gmail.com")).toBe(false);
    expect(isFelixMailAddress("sales@some-dealership.com.eg")).toBe(false);
  });

  it("does not match a lookalike domain", () => {
    // Suffix matching without the "@" would accept these.
    expect(isFelixMailAddress("someone@notfelixmail.508.world")).toBe(false);
    expect(isFelixMailAddress("someone@felixmail.508.world.example.com")).toBe(false);
  });

  it("does not match the domain appearing anywhere but the host", () => {
    expect(isFelixMailAddress("felixmail.508.world@gmail.com")).toBe(false);
  });
});
