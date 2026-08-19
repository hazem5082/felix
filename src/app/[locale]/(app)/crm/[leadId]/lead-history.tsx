import { getTranslations } from "next-intl/server";
import { ArrowRight } from "lucide-react";
import type { LeadHistoryEntry } from "@/lib/lead-history";

/**
 * Who changed what on this client, newest first.
 *
 * A Server Component: the entries are already built by the page, there is
 * nothing to interact with, and shipping the diffing to the browser would
 * put every historical value of every field into the HTML payload twice.
 *
 * The panel is the other half of making the client editable. Handing the
 * edit form to everyone who can see a lead is only safe if the record of
 * who edited it is visible to the same people — which is what migration
 * 0017's lead-scoped audit policy exists for.
 */
export async function LeadHistory({ entries }: { entries: LeadHistoryEntry[] }) {
  const t = await getTranslations("history");
  const misc = await getTranslations("misc");

  if (!entries.length) {
    return <p className="text-xs text-[var(--color-text-faint)]">{t("none")}</p>;
  }

  return (
    <ol className="space-y-3">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="border-b border-[var(--color-border)] pb-3 last:border-0 last:pb-0"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-faint)]">
            <span>
              {/* An audit row written by a seed script or by the service
                  role has no actor. "System" is honest; inventing a name
                  for it would be the one thing a history panel must not
                  do. */}
              {entry.actorName ?? misc("system")} · {t(`action.${entry.entity}.${entry.action}`)}
            </span>
            <span>{new Date(entry.at).toLocaleString()}</span>
          </div>

          {entry.subject && (
            <p className="mt-1 text-sm text-[var(--color-text)]">{entry.subject}</p>
          )}

          {entry.changes.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {entry.changes.map((change) => (
                <li key={change.field} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[var(--color-text-muted)]">
                    {t(`fields.${change.field}`)}
                  </span>
                  <span className="text-[var(--color-text-faint)] line-through">
                    {change.from ?? "—"}
                  </span>
                  <ArrowRight size={11} className="text-[var(--color-text-faint)]" />
                  <span className="text-[var(--color-text)]">{change.to ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
