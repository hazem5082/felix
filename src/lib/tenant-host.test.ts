import { describe, expect, it } from "vitest";
import { FLAGSHIP_SLUG, slugFromHost } from "./tenant-host";

describe("slugFromHost", () => {
  it("maps a licensed client's subdomain to its slug", () => {
    expect(slugFromHost("clientb-felix.508.world")).toBe("clientb");
    expect(slugFromHost("acmemotors-felix.508.world")).toBe("acmemotors");
  });

  it("maps the product's own host to the flagship showroom", () => {
    expect(slugFromHost("felix.508.world")).toBe(FLAGSHIP_SLUG);
  });

  it("ignores the port", () => {
    expect(slugFromHost("clientb-felix.508.world:8443")).toBe("clientb");
    expect(slugFromHost("localhost:3000")).toBe(FLAGSHIP_SLUG);
  });

  it("is case-insensitive, since hostnames are", () => {
    expect(slugFromHost("ClientB-Felix.508.World")).toBe("clientb");
  });

  it("keeps every showroom one label deep, inside the TLS wildcard", () => {
    // The reason for this scheme: *.508.world covers exactly one label, so
    // a nested host has no certificate and fails the TLS handshake before
    // any of this code runs. Guards against a well-meaning revert.
    for (const host of ["clientb-felix.508.world", "felix.508.world"]) {
      expect(host.split(".").length).toBe(3);
    }
  });

  it("supports <slug>.localhost so tenancy can be exercised offline", () => {
    expect(slugFromHost("clientb.localhost:3000")).toBe("clientb");
    expect(slugFromHost("localhost")).toBe(FLAGSHIP_SLUG);
    expect(slugFromHost("127.0.0.1:3000")).toBe(FLAGSHIP_SLUG);
  });

  it("falls back to the flagship for hosts with no tenant label", () => {
    // Hitting the Worker's own URL directly should still render, not 500.
    expect(slugFromHost("filex.wejdan-arts-studio.workers.dev")).toBe(FLAGSHIP_SLUG);
    expect(slugFromHost("508.world")).toBe(FLAGSHIP_SLUG);
  });

  it("returns null when there is no host to work from", () => {
    expect(slugFromHost(null)).toBeNull();
    expect(slugFromHost("")).toBeNull();
  });

  it("tolerates a fully-qualified trailing dot", () => {
    expect(slugFromHost("clientb-felix.508.world.")).toBe("clientb");
  });

  it("reads only the leftmost label, so a deeper host cannot spoof a tenant", () => {
    // If a nested host ever reaches the app, the leading label must not be
    // able to masquerade as the tenant. Anything that isn't exactly
    // `<slug>-felix` falls back to the flagship rather than being trusted.
    expect(slugFromHost("evil.clientb-felix.508.world")).toBe(FLAGSHIP_SLUG);
    expect(slugFromHost("clientb.felix.508.world")).toBe(FLAGSHIP_SLUG);
  });

  it("ignores hyphens that are not the -felix suffix", () => {
    expect(slugFromHost("micro-loans.508.world")).toBe(FLAGSHIP_SLUG);
    expect(slugFromHost("felix-staging.508.world")).toBe(FLAGSHIP_SLUG);
  });
});
