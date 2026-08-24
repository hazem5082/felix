"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { AlertTriangle, Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import type { Branch, Profile } from "@/lib/supabase/types";
import { distributeLeads, type DistributeResult } from "./actions";

type Person = Pick<Profile, "id" | "full_name" | "role" | "branch_id">;

/**
 * Deal the branch's pending enquiries round the floor.
 *
 * TWO SWITCHES, ONE OF WHICH IS DANGEROUS, and the page says which.
 *
 * The safe default deals out only the enquiries that belong to NOBODY.
 * Each one gets an owner (without which the salesperson given the
 * follow-up could not open the lead — leads_select shows a sales exec
 * only their own) and a follow-up task for today.
 *
 * "Include enquiries that already have an owner" re-deals the whole
 * pending pipeline, which TAKES LEADS OFF PEOPLE. That is a real thing a
 * manager sometimes means — a salesperson left, the floor changed size —
 * and it is never something they should do because a checkbox was
 * already ticked. So it defaults off, it is worded as what it does
 * rather than as an option, and it carries a warning rather than a
 * tooltip.
 *
 * The split itself is round robin in name order, and the result below
 * says who got how many. See splitLeads() in lib/tasks.ts on why it is
 * not "whoever has the fewest open tasks".
 */
export function LeadSplitPanel({
  branches,
  day,
  defaultBranchId,
  people,
}: {
  branches: Branch[];
  day: string;
  defaultBranchId: string | null;
  people: Person[];
}) {
  const t = useTranslations("tasks");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [branchId, setBranchId] = useState(defaultBranchId ?? branches[0]?.id ?? "");
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [result, setResult] = useState<DistributeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameById = useMemo(() => new Map(people.map((p) => [p.id, p.full_name])), [people]);
  const floorSize = useMemo(
    () => people.filter((p) => p.role === "sales_exec" && p.branch_id === branchId).length,
    [people, branchId]
  );

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const outcome = await distributeLeads({
        branch_id: branchId,
        due_on: day,
        include_assigned: includeAssigned,
      });
      if ("error" in outcome) setError(outcome.error);
      else {
        setResult(outcome);
        router.refresh();
      }
    });
  }

  return (
    <Panel>
      <PanelHeader title={t("splitTitle")} subtitle={t("splitSubtitle")} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="split-branch">{t("colBranch")}</Label>
          <Select
            id="split-branch"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-end">
          <p className="text-xs text-[var(--color-text-muted)]">
            {floorSize === 0 ? t("splitNoFloor") : t("splitFloorSize", { count: floorSize })}
          </p>
        </div>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={includeAssigned}
          onChange={(e) => setIncludeAssigned(e.target.checked)}
        />
        <span className="text-xs">
          <span className="font-medium">{t("splitIncludeAssigned")}</span>
          <span className="block text-[var(--color-text-muted)]">
            {t("splitIncludeAssignedBody")}
          </span>
        </span>
      </label>

      {includeAssigned && (
        <p className="mt-2 flex items-start gap-2 text-xs font-medium text-[var(--color-accent-red)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t("splitReassignWarning")}
        </p>
      )}

      {error && (
        <p className="mt-3 text-xs font-medium text-[var(--color-accent-red)]">{error}</p>
      )}

      {result && (
        <div className="mt-3 rounded-md border border-[var(--color-border)] px-3 py-2.5 text-xs">
          <p className="font-medium">
            {t("splitResult", { created: result.created, moved: result.reassigned })}
          </p>
          {Object.keys(result.perPerson).length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[var(--color-text-muted)]">
              {Object.entries(result.perPerson).map(([id, count]) => (
                <li key={id}>
                  {nameById.get(id) ?? id}: {count}
                </li>
              ))}
            </ul>
          )}
          {result.created === 0 && (
            <p className="mt-1 text-[var(--color-text-muted)]">{t("splitNothingPending")}</p>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          variant="accent"
          size="sm"
          disabled={pending || !branchId || floorSize === 0}
          onClick={run}
        >
          <Shuffle size={12} />
          {t("splitAction")}
        </Button>
      </div>
    </Panel>
  );
}
