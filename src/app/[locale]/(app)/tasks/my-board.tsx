"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Check, Plus, RotateCcw, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { completionPercent, sortForBoard, summariseDay } from "@/lib/tasks";
import type { TaskRow } from "@/lib/supabase/types";
import { createTask, setTaskStatus } from "./actions";

/**
 * What this person owes today, and the two things they can do about it.
 *
 * TICK and DECLINE are separate buttons and the second one asks for a
 * reason. That is the whole design: a board where the only options are
 * "done" and silence turns every unfinished task into the same shrug,
 * and the evening report then cannot tell "the customer's phone was off
 * all day" from "I did not look at it". The reason travels with the task
 * into the report, which is what makes declining worth doing rather than
 * something to avoid.
 *
 * A WITHDRAWN TASK IS SHOWN, STRUCK THROUGH, and cannot be touched. The
 * assignee should be able to see that the instruction went away rather
 * than wonder whether they imagined it.
 */
export function MyBoard({ tasks, day }: { tasks: TaskRow[]; day: string }) {
  const t = useTranslations("tasks");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [declining, setDeclining] = useState<TaskRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const board = useMemo(() => sortForBoard(tasks), [tasks]);
  const counts = useMemo(() => summariseDay(tasks), [tasks]);

  function apply(id: string, status: "open" | "done" | "skipped", note: string) {
    setError(null);
    startTransition(async () => {
      const result = await setTaskStatus({ id, status, note });
      if ("error" in result) setError(result.error);
      else {
        setDeclining(null);
        router.refresh();
      }
    });
  }

  return (
    <Panel>
      <PanelHeader
        title={t("myBoard")}
        subtitle={
          counts.total === 0
            ? t("nothingAsked")
            : t("boardTally", {
                done: counts.done,
                total: counts.total,
                percent: completionPercent(counts),
              })
        }
        action={
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus size={12} />
            {t("addTodo")}
          </Button>
        }
      />

      {error && (
        <p className="mb-3 text-xs font-medium text-[var(--color-accent-red)]">{error}</p>
      )}

      {board.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">{t("boardEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {board.map((task) => {
            const settled = task.status === "done" || task.status === "skipped";
            const withdrawn = task.status === "cancelled";
            return (
              <li
                key={task.id}
                className={
                  "flex items-start justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2.5" +
                  (withdrawn ? " opacity-50" : "")
                }
              >
                <div className="min-w-0">
                  <p
                    className={
                      "text-sm font-medium" +
                      (task.status === "done" || withdrawn
                        ? " text-[var(--color-text-muted)] line-through"
                        : "")
                    }
                  >
                    {task.title}
                  </p>
                  {task.description && (
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                      {task.description}
                    </p>
                  )}
                  {task.completion_note && (
                    <p className="mt-1 text-xs text-[var(--color-accent)]">
                      {t("declinedBecause", { reason: task.completion_note })}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-[var(--color-text-faint)]">
                    {t(`origin_${task.origin}`)}
                  </p>
                </div>

                {withdrawn ? (
                  <span className="shrink-0 text-xs text-[var(--color-text-faint)]">
                    {t("withdrawn")}
                  </span>
                ) : (
                  <div className="flex shrink-0 gap-2">
                    {settled ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => apply(task.id, "open", "")}
                      >
                        <RotateCcw size={12} />
                        {t("reopen")}
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="success"
                          size="sm"
                          disabled={pending}
                          onClick={() => apply(task.id, "done", "")}
                        >
                          <Check size={12} />
                          {t("markDone")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => setDeclining(task)}
                        >
                          <SkipForward size={12} />
                          {t("decline")}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* MOUNTED ONLY WHILE OPEN, and that is not a style choice.
          DialogContent portals with `forceMount`, so a <Dialog open={false}>
          left rendered still puts its panel in the document — and the
          framer-motion wrapper animates it to opacity 1 regardless, because
          nothing keys the AnimatePresence on `open`. The result is a modal
          that is permanently visible over the page. Every other dialog in
          this codebase is conditional for the same reason. */}
      {declining && (
        <DeclineDialog
          task={declining}
          pending={pending}
          onClose={() => setDeclining(null)}
          onConfirm={(note) => apply(declining.id, "skipped", note)}
        />
      )}

      {adding && (
        <AddTodoDialog
          day={day}
          pending={pending}
          onClose={() => setAdding(false)}
          onSubmit={(title, description) => {
            setError(null);
            startTransition(async () => {
              const result = await createTask({
                title,
                description,
                due_on: day,
                assignee_id: null,
              });
              if ("error" in result) setError(result.error);
              else {
                setAdding(false);
                router.refresh();
              }
            });
          }}
        />
      )}
    </Panel>
  );
}

/**
 * Declining asks for a reason and does not accept an empty one.
 *
 * The reason IS the feature. A decline with no explanation is
 * indistinguishable from a task nobody looked at, and the report would
 * then be reporting the same thing twice under two names.
 */
function DeclineDialog({
  task,
  pending,
  onClose,
  onConfirm,
}: {
  task: TaskRow;
  pending: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const t = useTranslations("tasks");
  // Mounted only while open, so the field starts empty every time
  // without anybody having to remember to clear it.
  const [note, setNote] = useState("");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={t("declineTitle")}>
        {/* Which task, named. The button that opened this sits in a list
            of near-identical rows, and a reason typed against the wrong
            one is worse than no reason. */}
        <p className="text-sm font-medium">{task.title}</p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t("declineBody")}</p>
        <div className="mt-4">
          <Label htmlFor="decline-note">{t("declineReason")}</Label>
          <Textarea
            id="decline-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("declineReasonPlaceholder")}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || note.trim().length === 0}
            onClick={() => onConfirm(note.trim())}
          >
            {t("declineConfirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Anybody's own to-do. Lands on their own board, for today, and nowhere else. */
function AddTodoDialog({
  day,
  pending,
  onClose,
  onSubmit,
}: {
  day: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (title: string, description: string) => void;
}) {
  const t = useTranslations("tasks");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent title={t("addTodoTitle")}>
        <p className="text-xs text-[var(--color-text-muted)]">{t("addTodoBody", { day })}</p>
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="todo-title">{t("taskTitle")}</Label>
            <Input
              id="todo-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={160}
            />
          </div>
          <div>
            <Label htmlFor="todo-desc">{t("taskNote")}</Label>
            <Textarea
              id="todo-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || title.trim().length === 0}
            onClick={() => onSubmit(title.trim(), description.trim())}
          >
            {t("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
