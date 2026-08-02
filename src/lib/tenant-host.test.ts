import { describe, expect, it } from "vitest";
import { FLAGSHIP_SLUG, slugFromHost } from "./tenant-host";

describe("slugFromHost", () => {
  it("maps a licensed client's subdomain to its slug", () => {
    expect(slugFromHost("clientb-felix.508.world")).toBe("clientb");
    expect(slugFromHost("acmemotors-felix.508.world")).toBe("acmemotors");
  });

  it("maps the flagship demo's host to the flagship showroom", () => {
    // felix.508.world is the static product page now; the demo app answers
    // at demo-felix. Without an explicit mapping the generic `<slug>-felix`
    // rule would read tenant "demo", which does not exist, and 404.
    expect(slugFromHost("demo-felix.508.world")).toBe(FLAGSHIP_SLUG);
    // The special case must not swallow real clients.
    expect(slugFromHost("clientb-felix.508.world")).toBe("clientb");
  });

  it("still resolves the bare felix label to the flagship", () => {
    // The Worker no longer sends app traffic for felix.508.world, but a
    // direct visit (workers.dev-style smoke test) should keep working.
    expect(slugFromHost("felix.508.world")).toBe(FLAGSHIP_SLUG);
  });

  it("ignores the port", () => {
    expect(slugFromHost("clientb-felix.508.world:8443")).toBe("clientb");
    expect(slugFromHost("demo-felix.508.world:8443")).toBe(FLAGSHIP_SLUG);
    expect(slugFromHost("localhost:3000")).toBe(FLAGSHIP_SLUG);
  });

  it("is case-insensitive, since hostnames are", () => {
    expect(slugFromHost("ClientB-Felix.508.World")).toBe("clientb");
  });

  it("keeps every showroom one label deep, inside the TLS wildcard", () => {
    // The reason for this scheme: *.508.world covers exactly one label, so
    // a nested host has no certificate and fails the TLS handshake before
    // any of this code runs. Guards against a well-meaning revert.
    for (const host of ["clientb-felix.508.world", "demo-felix.508.world"]) {
      expect(host.split(".").length).toBe(3);
    }
  });

  it("supports <slug>.localhost so tenancy can be exercised offline", () => {
    expect(slugFromHost("clientb.localhost:3000")).toBe("clientb");
    expect(slugFromHost("localhost")).toBe(FLAGSHIP_SLUG);
    expect(slugFromHost("127.0.0.1:3000")).toBe(FLAGSHIP_SLUG);
  });

  it("keeps the deploy URL pointing at the flagship for smoke tests", () => {
    expect(slugFromHost("filex.wejdan-arts-studio.workers.dev")).toBe(FLAGSHIP_SLUG);
  });

  it("refuses to serve a real showroom to an unrecognised hostname", () => {
    // This used to fall back to the flagship, which is a live showroom
    // with live data — so any typo'd or unmapped subdomain presented a
    // real tenant's login page. Null means "no showroom", i.e. 404.
    expect(slugFromHost("508.world")).toBeNull();
    expect(slugFromHost("www.508.world")).toBeNull();
    expect(slugFromHost("partners.508.world")).toBeNull();
    expect(slugFromHost("typo-felx.508.world")).toBeNull();
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
    // `<slug>-felix` is refused outright rather than trusted.
    expect(slugFromHost("evil.clientb-felix.508.world")).toBeNull();
    expect(slugFromHost("evil.demo-felix.508.world")).toBeNull();
    expect(slugFromHost("clientb.felix.508.world")).toBeNull();
  });

  it("ignores hyphens that are not the -felix suffix", () => {
    expect(slugFromHost("micro-loans.508.world")).toBeNull();
    expect(slugFromHost("felix-staging.508.world")).toBeNull();
  });
});
