import { describe, expect, it } from "vitest";
import { buildDemand, interestLabel, type DemandLead } from "./demand";
import type { LeadVehicleInterest, Vehicle } from "./supabase/types";

const civic = {
  id: "veh-civic",
  year: 2023,
  make: "Honda",
  model: "Civic",
  trim: "Sport",
  purchase_price: 20000,
} as Vehicle;

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

const lead = (over: Partial<DemandLead> = {}): DemandLead => ({
  id: "lead-x",
  car_interest: null,
  status: "pending",
  ...over,
});

describe("interestLabel", () => {
  it("prefers the joined vehicle over the free-text want", () => {
    expect(interestLabel(interest({ vehicles: civic, wanted_make: "Toyota" }))).toBe(
      "2023 Honda Civic Sport"
    );
  });

  it("builds a label from whichever wanted_* fields were filled in", () => {
    expect(interestLabel(interest({ wanted_make: "BMW" }))).toBe("BMW");
    expect(interestLabel(interest({ wanted_make: "BMW", wanted_year: 2024 }))).toBe("2024 BMW");
  });
});

describe("buildDemand", () => {
  it("counts distinct leads, not rows", () => {
    // The same buyer looking at the car twice is one buyer. Without the set
    // this reads as two, which is the number a purchasing decision is made on.
    const [row] = buildDemand([
      interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic, budget_amount: 21000 }),
      interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic, budget_amount: 19000 }),
      interest({ lead_id: "b", vehicle_id: civic.id, vehicles: civic, budget_amount: 22000 }),
    ]);
    expect(row.requestedBy).toBe(2);
    expect(row.topBudget).toBe(22000);
    expect(row.lowBudget).toBe(19000);
    expect(row.quoted).toBe(3);
  });

  it("keeps what buyers asked for apart from what we suggested", () => {
    const [row] = buildDemand([
      interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic }),
      interest({ lead_id: "b", vehicle_id: civic.id, vehicles: civic, origin: "suggested" }),
    ]);
    expect(row.requestedBy).toBe(1);
    expect(row.suggestedTo).toBe(1);
  });

  it("does not count a lead twice when they both asked and were shown it", () => {
    const [row] = buildDemand([
      interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic }),
      interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic, origin: "suggested" }),
    ]);
    expect(row.requestedBy).toBe(1);
    expect(row.suggestedTo).toBe(0);
  });

  it("drops declined interests so a buyer who walked away leaves the report", () => {
    expect(
      buildDemand([
        interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic, status: "declined" }),
      ])
    ).toEqual([]);
  });

  it("carries stock and cost through from the joined vehicle", () => {
    const [row] = buildDemand([
      interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic, budget_amount: 18000 }),
    ]);
    expect(row.inStock).toBe(true);
    expect(row.vehicleId).toBe("veh-civic");
    expect(row.purchasePrice).toBe(20000);
  });

  it("keeps a car nobody holds, which is the row the report exists for", () => {
    const [row] = buildDemand([
      interest({ lead_id: "a", wanted_make: "Toyota", wanted_model: "Hilux", budget_amount: 30000 }),
    ]);
    expect(row.inStock).toBe(false);
    expect(row.purchasePrice).toBeNull();
    expect(row.label).toBe("Toyota Hilux");
    expect(row.topBudget).toBe(30000);
  });

  it("merges a structured want with the free text a lead was captured with", () => {
    const rows = buildDemand(
      [
        interest({
          lead_id: "a",
          wanted_year: 2023,
          wanted_make: "Honda",
          wanted_model: "Civic",
          budget_amount: 21000,
        }),
      ],
      [lead({ id: "b", car_interest: "2023  honda civic" })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedBy).toBe(2);
    expect(rows[0].quoted).toBe(1);
  });

  it("lets a joined vehicle claim the label and price of a free-text bucket", () => {
    const rows = buildDemand(
      [interest({ lead_id: "a", vehicle_id: civic.id, vehicles: civic })],
      [lead({ id: "b", car_interest: "2023 Honda Civic Sport" })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].inStock).toBe(true);
    expect(rows[0].purchasePrice).toBe(20000);
    expect(rows[0].requestedBy).toBe(2);
  });

  it("marks a free-text-only row unlinked, so it is not reported as out of stock", () => {
    const [row] = buildDemand([], [lead({ id: "a", car_interest: "2023 Honda Civic" })]);
    expect(row.linked).toBe(false);
    expect(row.inStock).toBe(false); // "nobody has said", not "no"
  });

  it("marks a row linked as soon as one real interest lands in it", () => {
    const [row] = buildDemand(
      [interest({ lead_id: "a", wanted_make: "Honda", wanted_model: "Civic" })],
      [lead({ id: "b", car_interest: "Honda Civic" })]
    );
    expect(row.linked).toBe(true);
    expect(row.requestedBy).toBe(2);
  });

  it("ignores car_interest once the lead has a structured interest", () => {
    // Otherwise recording what a buyer actually wants makes them count twice.
    const rows = buildDemand(
      [interest({ lead_id: "a", wanted_make: "Kia" })],
      [lead({ id: "a", car_interest: "Kia" })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedBy).toBe(1);
  });

  it("ignores closed leads and blank car_interest", () => {
    expect(
      buildDemand([], [
        lead({ id: "a", car_interest: "Mazda", status: "closed" }),
        lead({ id: "b", car_interest: "   " }),
        lead({ id: "c" }),
      ])
    ).toEqual([]);
  });

  it("ranks by how many buyers asked, then by the best offer", () => {
    const rows = buildDemand([
      interest({ lead_id: "a", wanted_make: "Kia", budget_amount: 40000 }),
      interest({ lead_id: "b", wanted_make: "Mazda", budget_amount: 10000 }),
      interest({ lead_id: "c", wanted_make: "Mazda", budget_amount: 12000 }),
      interest({ lead_id: "d", wanted_make: "Ford", budget_amount: 50000 }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Mazda", "Ford", "Kia"]);
  });

  it("keeps a buyer who would not name a figure", () => {
    const [row] = buildDemand([interest({ lead_id: "a", wanted_make: "Nissan" })]);
    expect(row.requestedBy).toBe(1);
    expect(row.quoted).toBe(0);
    expect(row.topBudget).toBeNull();
    expect(row.lowBudget).toBeNull();
  });
});
