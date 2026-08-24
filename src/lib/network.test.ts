import { describe, expect, it } from "vitest";
import {
  buildWantedList,
  coarseFilter,
  compareMatches,
  isSearchable,
  normalise,
  parseQuery,
  scoreVehicle,
  vehicleHaystack,
  yearIn,
} from "./network";
import type { Lead, LeadVehicleInterest } from "./supabase/types";

let seq = 0;

function interest(over: Partial<LeadVehicleInterest> = {}): LeadVehicleInterest {
  return {
    id: `int-${seq++}`,
    lead_id: "lead-1",
    vehicle_id: null,
    wanted_make: null,
    wanted_model: null,
    wanted_year: null,
    budget_amount: null,
    origin: "requested",
    status: "open",
    note: null,
    created_by: "user-1",
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    branch_id: "branch-1",
    salesperson_id: "user-1",
    client_name: "Ahmed Fouad",
    phone_number: "01000000000",
    address: null,
    company_name: null,
    job_title: null,
    income: null,
    car_interest: null,
    source: "manual",
    status: "pending",
    contact_time_preference: null,
    client_notes: null,
    client_note_points: [],
    national_id: null,
    nationality: null,
    customer_id: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  } as Lead;
}

const car = (over: Partial<Parameters<typeof vehicleHaystack>[0]> = {}) => ({
  year: 2022,
  make: "Toyota",
  model: "Hilux",
  trim: null,
  color: null,
  ...over,
});

describe("normalise", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalise("  Toyota   HILUX  ")).toBe("toyota hilux");
  });

  it("splits on hyphens and dots rather than deleting them", () => {
    // "E-Class" and "E Class" are the same car; joining them into
    // "eclass" would match neither against a model column of "E Class".
    expect(normalise("E-Class")).toBe("e class");
    expect(normalise("4.0 V8")).toBe("4 0 v8");
  });

  it("keeps Arabic letters", () => {
    expect(normalise("تويوتا هايلكس")).toBe("تويوتا هايلكس");
  });
});

describe("yearIn", () => {
  it("finds a model year", () => {
    expect(yearIn("2022 hilux")).toBe(2022);
    expect(yearIn("hilux 1998")).toBe(1998);
  });

  it("ignores numbers that are not years", () => {
    expect(yearIn("bmw 320")).toBeNull();
    expect(yearIn("f 150")).toBeNull();
  });
});

describe("parseQuery", () => {
  it("lifts the year out of the words", () => {
    const q = parseQuery("Toyota Hilux 2022");
    expect(q.tokens).toEqual(["toyota", "hilux"]);
    expect(q.year).toBe(2022);
  });

  it("survives a query that is only a year", () => {
    const q = parseQuery("2023");
    expect(q.tokens).toEqual([]);
    expect(q.year).toBe(2023);
    expect(isSearchable(q)).toBe(true);
  });

  it("refuses a query too short to be worth a network round trip", () => {
    expect(isSearchable(parseQuery("a"))).toBe(false);
    expect(isSearchable(parseQuery("   "))).toBe(false);
    expect(isSearchable(parseQuery("bmw"))).toBe(true);
  });
});

describe("scoreVehicle", () => {
  it("requires every word, not any", () => {
    const q = parseQuery("toyota hilux");
    expect(scoreVehicle(car(), q)).not.toBeNull();
    // A Corolla is a Toyota and is still not what was asked for.
    expect(scoreVehicle(car({ model: "Corolla" }), q)).toBeNull();
  });

  it("matches a word the buyer only half-spelled", () => {
    expect(scoreVehicle(car({ make: "Toyota", model: "RAV4" }), parseQuery("rav"))).not.toBeNull();
  });

  it("does not match mid-word", () => {
    // "lux" appears inside "Hilux" and must not count — otherwise a
    // one-syllable query drags back half the network.
    expect(scoreVehicle(car(), parseQuery("lux"))).toBeNull();
  });

  it("scores a whole word above a prefix", () => {
    const whole = scoreVehicle(car({ model: "Civic", make: "Honda" }), parseQuery("civic"))!;
    const prefix = scoreVehicle(car({ model: "Civic", make: "Honda" }), parseQuery("civ"))!;
    expect(whole).toBeGreaterThan(prefix);
  });

  it("searches the trim and the colour too", () => {
    const white = car({ model: "Land Cruiser", color: "White", trim: "GXR" });
    expect(scoreVehicle(white, parseQuery("white land cruiser"))).not.toBeNull();
    expect(scoreVehicle(white, parseQuery("gxr"))).not.toBeNull();
  });

  it("ranks by year without ever disqualifying on it", () => {
    const q = parseQuery("hilux 2022");
    const exact = scoreVehicle(car({ year: 2022 }), q)!;
    const near = scoreVehicle(car({ year: 2023 }), q)!;
    const far = scoreVehicle(car({ year: 2016 }), q)!;

    expect(exact).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(far);
    // The point of the rule: the 2016 is still an answer, not a miss.
    expect(far).not.toBeNull();
  });

  it("answers a year-only query with everything", () => {
    const q = parseQuery("2022");
    expect(scoreVehicle(car({ make: "Kia", model: "Sportage" }), q)).toBe(3);
  });
});

describe("compareMatches", () => {
  it("puts the best score first, then the newest car", () => {
    const rows = [
      { score: 4, vehicle: { year: 2019, id: "b" } },
      { score: 7, vehicle: { year: 2018, id: "a" } },
      { score: 4, vehicle: { year: 2024, id: "c" } },
    ];
    expect(rows.sort(compareMatches).map((r) => r.vehicle.id)).toEqual(["a", "c", "b"]);
  });
});

describe("coarseFilter", () => {
  it("ANDs the words, ORing each across every name column", () => {
    // The same rule scoreVehicle() applies, expressed once so there is
    // no question about how repeated filters would have combined.
    expect(coarseFilter(parseQuery("toyota hilux"))).toBe(
      "and(or(make.ilike.*toyota*,model.ilike.*toyota*,trim.ilike.*toyota*,color.ilike.*toyota*)," +
        "or(make.ilike.*hilux*,model.ilike.*hilux*,trim.ilike.*hilux*,color.ilike.*hilux*))"
    );
  });

  it("needs no conjunction for one word", () => {
    expect(coarseFilter(parseQuery("hilux"))).toBe(
      "make.ilike.*hilux*,model.ilike.*hilux*,trim.ilike.*hilux*,color.ilike.*hilux*"
    );
  });

  it("has nothing to filter on for a year-only search", () => {
    expect(coarseFilter(parseQuery("2023"))).toBeNull();
  });

  it("caps a rambling query so the request URL stays sane", () => {
    const filter = coarseFilter(parseQuery("white toyota land cruiser gxr v8"))!;
    expect(filter.match(/or\(/g)).toHaveLength(4);
  });

  it("emits only syntax it wrote itself", () => {
    // Punctuation in the query must never reach PostgREST as syntax —
    // normalise() strips it, and this is the assertion that says so.
    const filter = coarseFilter(parseQuery("bmw, x5 (m-sport)"))!;
    const values = [...filter.matchAll(/ilike\.\*([^*]*)\*/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toMatch(/^[\p{L}\p{N}]+$/u);
    expect(filter.startsWith("and(or(")).toBe(true);
    // bmw, x5, m, sport — "m" is one character and is dropped.
    expect(filter.match(/or\(/g)).toHaveLength(3);
  });
});

describe("buildWantedList", () => {
  it("keeps only open asks for cars the showroom does not hold", () => {
    const wanted = buildWantedList({
      interests: [
        interest({ wanted_make: "Toyota", wanted_model: "Hilux", wanted_year: 2022 }),
        // Answered by the floor already.
        interest({ vehicle_id: "veh-1", wanted_make: "Toyota", wanted_model: "Hilux" }),
        // Conversation closed.
        interest({ wanted_make: "Kia", wanted_model: "Sportage", status: "declined" }),
      ],
      leads: [lead()],
    });

    expect(wanted).toHaveLength(1);
    expect(wanted[0].query).toBe("toyota hilux");
    expect(wanted[0].label).toBe("2022 Toyota Hilux");
    expect(wanted[0].year).toBe(2022);
  });

  it("keeps a salesperson's unfilled suggestion, marked as one", () => {
    const wanted = buildWantedList({
      interests: [interest({ wanted_make: "BMW", wanted_model: "X5", origin: "suggested" })],
      leads: [lead()],
    });
    expect(wanted[0].origin).toBe("suggested");
  });

  it("falls back to the enquiry note when nobody filled in an interest", () => {
    const wanted = buildWantedList({
      interests: [],
      leads: [lead({ id: "lead-9", car_interest: "2021 Mercedes E-Class" })],
    });

    expect(wanted).toHaveLength(1);
    expect(wanted[0].key).toBe("lead:lead-9");
    expect(wanted[0].origin).toBe("note");
    expect(wanted[0].query).toBe("mercedes e class");
    expect(wanted[0].year).toBe(2021);
  });

  it("does not double-count a lead that has both", () => {
    // The interest row is the considered answer; the note is what
    // somebody typed in a hurry on the way to writing it.
    const wanted = buildWantedList({
      interests: [interest({ lead_id: "lead-1", wanted_make: "Toyota", wanted_model: "Hilux" })],
      leads: [lead({ id: "lead-1", car_interest: "hilux maybe" })],
    });
    expect(wanted).toHaveLength(1);
    expect(wanted[0].origin).toBe("requested");
  });

  it("ignores a closed lead's note", () => {
    const wanted = buildWantedList({
      interests: [],
      leads: [lead({ status: "closed", car_interest: "Toyota Hilux" })],
    });
    expect(wanted).toEqual([]);
  });

  it("drops an interest whose lead this reader cannot see", () => {
    // RLS can hand back an interest without its lead. Rendering the row
    // with a blank name would be worse than not rendering it.
    const wanted = buildWantedList({
      interests: [interest({ lead_id: "invisible", wanted_make: "Toyota", wanted_model: "Hilux" })],
      leads: [lead({ id: "lead-1" })],
    });
    expect(wanted).toEqual([]);
  });

  it("returns the newest ask first", () => {
    const wanted = buildWantedList({
      interests: [
        interest({ wanted_make: "Kia", created_at: "2026-01-01T00:00:00Z" }),
        interest({ wanted_make: "BMW", created_at: "2026-06-01T00:00:00Z" }),
      ],
      leads: [lead()],
    });
    expect(wanted.map((w) => w.query)).toEqual(["bmw", "kia"]);
  });
});

