import { describe, expect, it } from "vitest";
import {
  DEFAULT_RADIUS_M,
  MAX_ACCURACY_SLACK_M,
  distanceMetres,
  formatDistance,
  geofenceFromBranch,
  isWithinGeofence,
  parseCoordinate,
} from "./geo";

// Downtown Cairo, the pin used throughout the migration's own tests.
const SHOWROOM = { latitude: 30.04442, longitude: 31.235712 };

describe("distanceMetres", () => {
  it("is zero at the pin", () => {
    expect(distanceMetres(SHOWROOM, SHOWROOM)).toBe(0);
  });

  it("agrees with the trigger's haversine to the metre", () => {
    // The exact case migration 0038's live test asserts: 0.01 degrees
    // of latitude north of the pin, which Postgres computed as 1112 m.
    const north = { latitude: 30.05442, longitude: 31.235712 };
    expect(distanceMetres(SHOWROOM, north)).toBe(1112);
  });

  it("is symmetric", () => {
    const a = { latitude: 30.05, longitude: 31.24 };
    expect(distanceMetres(SHOWROOM, a)).toBe(distanceMetres(a, SHOWROOM));
  });

  it("handles the antimeridian without producing a short-way error", () => {
    const west = { latitude: 0, longitude: -179.999 };
    const east = { latitude: 0, longitude: 179.999 };
    // ~222 m apart across the line, not most of the way round the planet.
    expect(distanceMetres(west, east)).toBeLessThan(300);
  });
});

describe("isWithinGeofence", () => {
  const fence = { ...SHOWROOM, radiusM: 150 };

  it("admits a punch on the pin", () => {
    expect(isWithinGeofence(fence, SHOWROOM, 5)).toBe(true);
  });

  it("refuses one a kilometre away", () => {
    expect(isWithinGeofence(fence, { latitude: 30.05442, longitude: 31.235712 }, 10)).toBe(false);
  });

  it("honours reported GPS accuracy as slack", () => {
    // ~98 m out: outside a 150 m fence? No — inside. But at a 50 m
    // fence it is outside unless the phone's own accuracy covers it.
    const near = { latitude: 30.0453, longitude: 31.235712 };
    expect(isWithinGeofence({ ...SHOWROOM, radiusM: 50 }, near, 0)).toBe(false);
    expect(isWithinGeofence({ ...SHOWROOM, radiusM: 50 }, near, 60)).toBe(true);
  });

  it("CLAMPS that slack, so a lying accuracy buys 100 m and not a kilometre", () => {
    const far = { latitude: 30.05442, longitude: 31.235712 }; // 1112 m
    expect(isWithinGeofence(fence, far, 999_999)).toBe(false);
    expect(MAX_ACCURACY_SLACK_M).toBe(100);
    // The clamp contributes exactly 100 m and never more: at 1112 m out,
    // a 1000 m fence still refuses (1000 + 100 < 1112) and a 1020 m one
    // admits (1020 + 100 >= 1112). An unclamped 999999 would have
    // admitted both.
    expect(isWithinGeofence({ ...SHOWROOM, radiusM: 1000 }, far, 999_999)).toBe(false);
    expect(isWithinGeofence({ ...SHOWROOM, radiusM: 1020 }, far, 999_999)).toBe(true);
    expect(isWithinGeofence({ ...SHOWROOM, radiusM: 1020 }, far, 0)).toBe(false);
  });

  it("ignores a negative accuracy rather than shrinking the fence", () => {
    expect(isWithinGeofence(fence, SHOWROOM, -500)).toBe(true);
  });

  it("returns null — NOT false — when the branch has never been pinned", () => {
    expect(isWithinGeofence(null, SHOWROOM, 5)).toBeNull();
  });

  it("returns null when the phone gave no position", () => {
    expect(isWithinGeofence(fence, null, null)).toBeNull();
  });
});

describe("geofenceFromBranch", () => {
  it("reads numeric strings, which is how postgres numerics arrive", () => {
    const f = geofenceFromBranch({
      latitude: "30.044420",
      longitude: "31.235712",
      geofence_radius_m: "150",
    });
    expect(f).toEqual({ latitude: 30.04442, longitude: 31.235712, radiusM: 150 });
  });

  it("is null for an unpinned branch", () => {
    expect(geofenceFromBranch({ latitude: null, longitude: null, geofence_radius_m: 150 })).toBeNull();
  });

  it("is null for a half-entered pin rather than guessing the other half", () => {
    expect(geofenceFromBranch({ latitude: "30.04", longitude: null, geofence_radius_m: 150 })).toBeNull();
  });

  it("falls back to the column default when the radius is missing", () => {
    const f = geofenceFromBranch({ latitude: 30, longitude: 31, geofence_radius_m: null });
    expect(f?.radiusM).toBe(DEFAULT_RADIUS_M);
  });
});

describe("parseCoordinate", () => {
  it("accepts a pasted decimal pair", () => {
    expect(parseCoordinate("30.044420", "lat")).toBe(30.04442);
    expect(parseCoordinate("  31.235712 ", "lng")).toBe(31.235712);
  });

  it("rejects out-of-range values instead of placing a pin at sea", () => {
    expect(parseCoordinate("91", "lat")).toBeNull();
    expect(parseCoordinate("-181", "lng")).toBeNull();
  });

  it("rejects text rather than returning NaN", () => {
    expect(parseCoordinate("", "lat")).toBeNull();
    expect(parseCoordinate("thirty", "lat")).toBeNull();
  });
});

describe("formatDistance", () => {
  it("uses metres up to a kilometre and then one decimal", () => {
    expect(formatDistance(40)).toBe("40 m");
    expect(formatDistance("1112")).toBe("1.1 km");
    expect(formatDistance(null)).toBe("—");
  });
});
