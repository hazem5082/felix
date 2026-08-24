"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { completionPercent, sortForBoard, summariseDay } from "@/lib/tasks";
import type { Branch, Profile, TaskRow } from "@/lib/supabase/types";
import { setTaskStatus } from "./actions";

type Person = Pick<Profile, "id" | "full_name" | "role" | "branch_id">;

/**
 * The floor, today, one row per person.
 *
 * WHAT IT DOES NOT SHOW: yesterday. A manager wanting history opens the
 * person's day_reports, and a board that quietly widened to a week would
 * be a performance review rendered as a table — which is a different
 * screen with different consequences and should be built as one when it
 * is wanted.
 *
 * PEOPLE WITH NOTHING ASKED OF THEM STILL APPEAR, at zero of zero. An
 * empty board is a fact about the manager who set no templates, not
 * about the salesperson, and hiding the row would hide the wrong one of
 * those two.
 *
 * The only write here is WITHDRAW, and it is the manager's half of the
 * pair the assignee holds: they may tick or decline, the manager may
 * take the instruction back. Neither can do the other's, which is why
 * set_task_status() decides rather than a policy.
 */
export function TeamBoard({
  tasks,
  people,
  branches,
}: {
  tasks: TaskRow[];
  people: Person[];
  branches: Branch[];
}) {
  const t = useTranslations("tasks");
  // The role labels already exist and are already translated; a second
  // copy under "tasks" would be one more thing to keep in step.
  const roleName = useTranslations("roles");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const branchName = useMemo(
    () => new Map(branches.map((b) => [b.id, b.name])),
    [branches]
  );

  const rows = useMemo(() => {
    const byPerson = new Map<string, TaskRow[]>();
    for (const task of tasks) {
      const list = byPerson.get(task.assignee_id) ?? [];
      list.push(task);
      byPerson.set(task.assignee_id, list);
    }
    return people
      .map((person) => {
        const own = byPerson.get(person.id) ?? [];
        return { person, tasks: sortForBoard(own), counts: summariseDay(own) };
      })
      // Most left undone first: the manager is reading this to find the
      // person who needs a word, not to admire the finished columns.
      .sort((a, b) => b.counts.open - a.counts.open || b.counts.total - a.counts.total);
  }, [tasks, people]);

  function withdraw(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await setTaskStatus({ id, status: "cancelled", note: "" });
      if ("error" in result) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <Panel>
      <PanelHeader title={t("teamTitle")} subtitle={t("teamSubtitle")} />

      {error && (
        <p className="mb-3 text-xs font-medium text-[var(--color-accent-red)]">{error}</p>
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">{t("teamEmpty")}</p>
      ) : (
        <Table>
          <THead>
            <Th>{t("colPerson")}</Th>
            <Th>{t("colBranch")}</Th>
            <Th className="text-end">{t("done")}</Th>
            <Th className="text-end">{t("declinedCount")}</Th>
            <Th className="text-end">{t("ignored")}</Th>
            <Th className="text-end">{""}</Th>
          </THead>
          <TBody>
            {rows.map(({ person, tasks: own, counts }) => (
              <Fragment key={person.id}>
                <Tr>
                  <Td className="font-medium">
                    {person.full_name}
                    <span className="ms-2 text-xs text-[var(--color-text-faint)]">
                      {roleName(person.role)}
                    </span>
                  </Td>
                  <Td className="text-[var(--color-text-muted)]">
                    {person.branch_id ? (branchName.get(person.branch_id) ?? "—") : "—"}
                  </Td>
                  <Td className="text-end tabular-nums text-[var(--color-accent-green)]">
                    {counts.done}
                  </Td>
                  <Td className="text-end tabular-nums">{counts.skipped}</Td>
                  <Td
                    className={
                      "text-end tabular-nums" +
                      (counts.open > 0 ? " text-[var(--color-accent-red)]" : "")
                    }
                  >
                    {counts.open}
                  </Td>
                  <Td className="text-end">
                    {counts.total === 0 ? (
                      <span className="text-xs text-[var(--color-text-faint)]">
                        {t("teamNothing")}
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpen(open === person.id ? null : person.id)}
                      >
                        {completionPercent(counts)}%
                      </Button>
                    )}
                  </Td>
                </Tr>
                {open === person.id &&
                  own.map((task) => (
                    <Tr key={task.id} className="bg-black/[0.015]">
                      <Td colSpan={5} className="ps-8 text-xs">
                        <span
                          className={
                            task.status === "done" || task.status === "cancelled"
                              ? "text-[var(--color-text-muted)] line-through"
                              : ""
                          }
                        >
                          {task.title}
                        </span>
                        {task.completion_note && (
                          <span className="ms-2 text-[var(--color-accent)]">
                            {t("declinedBecause", { reason: task.completion_note })}
                          </span>
                        )}
                      </Td>
                      <Td className="text-end">
                        {task.status === "cancelled" ? (
                          <span className="text-xs text-[var(--color-text-faint)]">
                            {t("withdrawn")}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => withdraw(task.id)}
                          >
                            <Undo2 size={12} />
                            {t("withdraw")}
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
              </Fragment>
            ))}
          </TBody>
        </Table>
      )}
    </Panel>
  );
}
