// The Egyptian national ID is 14 digits and the first seven encode the
// holder's birth date: C YY MM DD, where C names the century (2 = 1900s,
// 3 = 2000s). The remaining digits are governorate, sequence and a check
// digit — not decoded here because nothing in FELIX needs them.
//
// Everything returns null rather than throwing: IDs arrive from a free
// text field and predate the 14-digit CHECK, so a malformed one must
// degrade to "—" on the page, never to a crash.

export interface NationalIdBirth {
  /** ISO date (YYYY-MM-DD). */
  birthDate: string;
  age: number;
}

export function birthFromNationalId(
  nationalId: string | null | undefined,
  today: Date = new Date()
): NationalIdBirth | null {
  if (!nationalId || !/^[0-9]{14}$/.test(nationalId)) return null;

  const century = nationalId[0] === "2" ? 1900 : nationalId[0] === "3" ? 2000 : null;
  if (century === null) return null;

  const year = century + Number(nationalId.slice(1, 3));
  const month = Number(nationalId.slice(3, 5));
  const day = Number(nationalId.slice(5, 7));

  // Date.UTC would roll 02-31 over into March; constructing and reading
  // back is the cheapest way to reject an impossible date outright.
  const birth = new Date(Date.UTC(year, month - 1, day));
  if (
    birth.getUTCFullYear() !== year ||
    birth.getUTCMonth() !== month - 1 ||
    birth.getUTCDate() !== day
  ) {
    return null;
  }
  if (birth.getTime() > today.getTime()) return null;

  let age = today.getUTCFullYear() - year;
  const monthDiff = today.getUTCMonth() - (month - 1);
  if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < day)) age -= 1;

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { birthDate: iso, age };
}
