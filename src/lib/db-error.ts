import "server-only";
import type { ActionError } from "@/lib/validation";
import { localizeErrorMessage } from "@/lib/action-messages";

/**
 * Turns a Postgres/PostgREST failure into something a showroom owner
 * can read, and keeps the engine's own words in the server log where
 * they belong.
 *
 * Every mutating action used to `return { error: error.message }`, so a
 * duplicate VIN surfaced in the dialog as
 * `duplicate key value violates unique constraint "vehicles_vin_key"`.
 * That is unreadable, always English regardless of locale, and hands a
 * stranger the schema.
 *
 * Deliberately NOT mapped: `P0001` (raise_exception). Those are the
 * messages our own migrations author — "A branch manager may only
 * invite sales staff from their own branch" — and they are the most
 * useful thing we could possibly say, so they pass through verbatim.
 *
 * Async because it localizes: next-intl resolves the request locale in
 * Server Actions, and every caller is an async action that simply
 * returns this promise onward.
 */
export async function toUserError(
  error: { code?: string; message: string },
  context?: string
): Promise<ActionError> {
  console.error(`[db]${context ? ` ${context}:` : ""} ${error.code ?? "?"} ${error.message}`);

  switch (error.code) {
    case "23505": // unique_violation
      return { error: await localizeErrorMessage("That record already exists.") };
    case "23503": // foreign_key_violation
      return { error: await localizeErrorMessage("That refers to something that no longer exists.") };
    case "23514": // check_violation
      return {
        error: await localizeErrorMessage("Some of those values are not allowed together."),
      };
    case "23502": // not_null_violation
      return { error: await localizeErrorMessage("A required field was missing.") };
    case "42501": // insufficient_privilege
    case "PGRST301":
      return { error: await localizeErrorMessage("You do not have permission to do that.") };
    case "P0001": // our own RAISE EXCEPTION — the clearest message available
      return { error: error.message };
    default:
      if (/row-level security/i.test(error.message)) {
        return { error: await localizeErrorMessage("You do not have permission to do that.") };
      }
      return { error: await localizeErrorMessage("Something went wrong. Please try again.") };
  }
}
