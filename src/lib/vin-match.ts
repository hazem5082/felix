/**
 * True when a successfully decoded VIN names a different manufacturer
 * than the make already on record for this car — the "chassis number
 * doesn't match the paperwork" signal, and the only one this app treats
 * as fraud-worth-a-CEO-alert rather than routine data noise.
 *
 * Deliberately NOT based on a failed checksum: the position-9 check
 * digit only follows a fixed formula for North-American-market cars
 * (see vin-decode.ts), and most of a showroom trading grey-import/JDM/
 * GCC-spec stock will legitimately fail it. Alerting on that would
 * flood the CEO's inbox with cars that are simply imported, not fake.
 * A make mismatch has no such innocent explanation: the VIN and the
 * paperwork are describing two different vehicles.
 *
 * A blank/undecoded VIN (routine for stock outside vPIC's coverage) is
 * NOT a mismatch — there is nothing decoded to disagree with.
 */
export function vinMakeMismatch(
  decodedMake: string | null | undefined,
  recordedMake: string | null | undefined
): boolean {
  if (!decodedMake || !recordedMake) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(decodedMake);
  const b = norm(recordedMake);
  if (!a || !b) return false;
  // Substring check both ways tolerates "Mercedes" vs "Mercedes-Benz",
  // "Land Rover" vs "Landrover", etc. — spelling variance, not a
  // different manufacturer.
  return a !== b && !a.includes(b) && !b.includes(a);
}
