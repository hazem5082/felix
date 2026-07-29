"use client";

// NHTSA vPIC vehicle API — free, no key required, CORS-enabled.
const FALLBACK_MAKES = [
  "Toyota", "Honda", "Ford", "Chevrolet", "Nissan", "BMW", "Mercedes-Benz",
  "Audi", "Hyundai", "Kia", "Volkswagen", "Lexus", "Mazda", "Jeep",
  "Land Rover", "Porsche", "Volvo", "Subaru", "Mitsubishi", "GMC",
];

export const YEARS = Array.from({ length: 2027 - 1995 + 1 }, (_, i) => 2027 - i);

export async function fetchMakes(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://vpic.nhtsa.dot.gov/api/vehicles/GetAllMakes?format=json"
    );
    const data = await res.json();
    const makes: string[] = data.Results.map((r: { Make_Name: string }) =>
      r.Make_Name
        .toLowerCase()
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    );
    const unique = Array.from(new Set(makes)).sort();
    return unique.length ? unique : FALLBACK_MAKES;
  } catch {
    return FALLBACK_MAKES;
  }
}

export async function fetchModels(make: string, year: string): Promise<string[]> {
  if (!make || !year) return [];
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
        make
      )}/modelyear/${year}?format=json`
    );
    const data = await res.json();
    const models: string[] = data.Results.map((r: { Model_Name: string }) => r.Model_Name);
    return Array.from(new Set(models)).sort();
  } catch {
    return [];
  }
}

export const COMMON_TRIMS = ["Base", "Sport", "Premium", "Luxury", "Limited", "Other"];
