import { describe, expect, it } from "vitest";
import { buildLeadHistory, formatValue, vehicleIdsInHistory } from "./lead-history";
import type { AuditLogRow } from "./supabase/types";

let seq = 0;
function audit(over: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: `audit-${seq++}`,
    actor_id: "user-1",
    action: "update",
    entity_type: "leads",
    entity_id: "lead-1",
    detail: null,
    before_data: null,
    after_data: null,
    created_at: "2026-08-19T10:00:00Z",
    profiles: { full_name: "Sara" },
    ...over,
  };
}

describe("formatValue", () => {
  it("collapses null and empty string to nothing", () => {
    expect(formatValue("client_notes", null)).toBeNull();
    expect(formatValue("client_notes", "")).toBeNull();
    expect(formatValue("client_notes", "   ")).toBeNull();
  });

  it("joins note points into one readable line", () => {
    expect(formatValue("client_note_points", ["Needs an SUV", "Seven seats"])).toBe(
      "Needs an SUV • Seven seats"
    );
  });

  it("drops blank note points rather than printing empty bullets", () => {
    expect(formatValue("client_note_points", ["Needs an SUV", "  ", ""])).toBe("Needs an SUV");
    expect(formatValue("client_note_points", [])).toBeNull();
  });

  it("renders money with separators", () => {
    expect(formatValue("budget_amount", 21000)).toBe((21000).toLocaleString());
    expect(formatValue("income", "48000")).toBe((48000).toLocaleString());
  });

  it("resolves a vehicle id to its label, and falls back to the id", () => {
    expect(formatValue("vehicle_id", "veh-1", { "veh-1": "2023 Honda Civic" })).toBe(
      "2023 Honda Civic"
    );
    expect(formatValue("vehicle_id", "veh-9", {})).toBe("veh-9");
  });
});

describe("buildLeadHistory", () => {
  it("reports which lead field moved, and where to", () => {
    const [entry] = buildLeadHistory([
      audit({
        before_data: { phone_number: "0501111111", client_name: "Omar" },
        after_data: { phone_number: "0502222222", client_name: "Omar" },
      }),
    ]);

    expect(entry.entity).toBe("lead");
    expect(entry.action).toBe("update");
    expect(entry.actorName).toBe("Sara");
    expect(entry.changes).toEqual([
      { field: "phone_number", from: "0501111111", to: "0502222222" },
    ]);
  });

  it("shows note points being added under an unchanged heading", () => {
    const [entry] = buildLeadHistory([
      audit({
        before_data: { client_notes: "Married, three kids", client_note_points: [] },
        after_data: {
          client_notes: "Married, three kids",
          client_note_points: ["Bad roads — wants an SUV", "Seven seats"],
        },
      }),
    ]);

    expect(entry.changes).toEqual([
      {
        field: "client_note_points",
        from: null,
        to: "Bad roads — wants an SUV • Seven seats",
      },
    ]);
  });

  it("ignores columns outside the allowlist, so uuids never reach the panel", () => {
    const entries = buildLeadHistory([
      audit({
        before_data: { salesperson_id: "user-1", client_name: "Omar" },
        after_data: { salesperson_id: "user-2", client_name: "Omar" },
      }),
    ]);

    expect(entries).toEqual([]);
  });

  it("drops an update that moved nothing worth showing", () => {
    expect(
      buildLeadHistory([
        audit({ before_data: { client_name: "Omar" }, after_data: { client_name: "Omar" } }),
      ])
    ).toEqual([]);
  });

  it("treats a note cleared to empty string as unchanged from null", () => {
    expect(
      buildLeadHistory([
        audit({ before_data: { client_notes: null }, after_data: { client_notes: "" } }),
      ])
    ).toEqual([]);
  });

  it("lists no diff on an insert, because every field would read as new", () => {
    const [entry] = buildLeadHistory([
      audit({ action: "insert", before_data: null, after_data: { client_name: "Omar" } }),
    ]);

    expect(entry.action).toBe("insert");
    expect(entry.changes).toEqual([]);
  });

  it("names the car an interest entry is about", () => {
    const [added, relinked] = buildLeadHistory(
      [
        audit({
          entity_type: "lead_vehicle_interests",
          entity_id: "int-1",
          action: "insert",
          after_data: { wanted_make: "Toyota", wanted_model: "Hilux", wanted_year: 2023 },
        }),
        audit({
          entity_type: "lead_vehicle_interests",
          entity_id: "int-1",
          before_data: { vehicle_id: null, wanted_make: "Toyota", budget_amount: 21000 },
          after_data: { vehicle_id: "veh-1", wanted_make: "Toyota", budget_amount: 24000 },
        }),
      ],
      { "veh-1": "2023 Toyota Hilux SR5" }
    );

    expect(added.subject).toBe("2023 Toyota Hilux");
    expect(relinked.subject).toBe("2023 Toyota Hilux SR5");
    expect(relinked.changes).toEqual([
      { field: "vehicle_id", from: null, to: "2023 Toyota Hilux SR5" },
      { field: "budget_amount", from: (21000).toLocaleString(), to: (24000).toLocaleString() },
    ]);
  });

  it("skips audit rows for entities the panel does not render", () => {
    expect(
      buildLeadHistory([
        audit({
          entity_type: "vehicles",
          before_data: { purchase_price: 1 },
          after_data: { purchase_price: 2 },
        }),
      ])
    ).toEqual([]);
  });

  it("leaves the actor unnamed rather than inventing one", () => {
    const [entry] = buildLeadHistory([
      audit({
        actor_id: null,
        profiles: null,
        before_data: { client_name: "Omar" },
        after_data: { client_name: "Omar Ali" },
      }),
    ]);

    expect(entry.actorName).toBeNull();
  });
});

describe("vehicleIdsInHistory", () => {
  it("collects both sides of a relink, so the old car is nameable too", () => {
    const ids = vehicleIdsInHistory([
      audit({
        entity_type: "lead_vehicle_interests",
        before_data: { vehicle_id: "veh-old" },
        after_data: { vehicle_id: "veh-new" },
      }),
      audit({ entity_type: "leads", after_data: { client_name: "Omar" } }),
    ]);

    expect(ids.sort()).toEqual(["veh-new", "veh-old"]);
  });

  it("returns nothing for interests that name no stock", () => {
    expect(
      vehicleIdsInHistory([
        audit({
          entity_type: "lead_vehicle_interests",
          before_data: { vehicle_id: null },
          after_data: { vehicle_id: null, wanted_make: "Kia" },
        }),
      ])
    ).toEqual([]);
  });
});
