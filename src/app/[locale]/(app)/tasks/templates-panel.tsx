"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Pencil, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { MAX_DAY_OF_MONTH, RECURRENCES, WEEKDAYS, templateDueOn } from "@/lib/tasks";
import type { Branch, Profile, TaskTemplate } from "@/lib/supabase/types";
import { materialiseTasks, saveTaskTemplate, setTaskTemplateActive } from "./actions";

type Person = Pick<Profile, "id" | "full_name" | "role" | "branch_id">;

/** Roles a standing instruction can be aimed at. Investors are not staff. */
const TARGET_ROLES = [
  "sales_exec",
  "branch_manager",
  "marketing",
  "accountant",
  "hr",
  "ceo",
] as const;

/**
 * The standing instructions, and the form that writes them.
 *
 * A TEMPLATE AIMS AT A ROLE OR AT ONE PERSON, never both. That is a
 * database CHECK, not a UI preference, and the form is a radio pair
 * rather than two optional fields so the invalid combination cannot be
 * typed in the first place. "Every sales exec at Maadi" is the common
 * case; "Karim, every Monday" is the other one; "everybody" is neither
 * and would be a fourth kind of thing nobody asked for.
 *
 * SAVING MATERIALISES IMMEDIATELY when the new template falls due today.
 * A manager who writes "daily: ring your leads" at 09:00 expects it on
 * the floor at 09:01 — a board that only picks it up tomorrow reads as a
 * bug, and the RPC is idempotent so the extra call costs a no-op on the
 * days it does not apply.
 */
export function TemplatesPanel({
  templates,
  branches,
  people,
  isCeo,
  day,
}: {
  templates: TaskTemplate[];
  branches: Branch[];
  people: Person[];
  isCeo: boolean;
  day: string;
}) {
  const t = useTranslations("tasks");
  const roleName = useTranslations("roles");
  const router = useRouter();
  const [editing, setEditing] = useState<TaskTemplate | "new" | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const branchName = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const personName = useMemo(() => new Map(people.map((p) => [p.id, p.full_name])), [people]);

  function toggle(template: TaskTemplate) {
    setError(null);
    startTransition(async () => {
      const result = await setTaskTemplateActive({
        id: template.id,
        active: !template.active,
      });
      if ("error" in result) setError(result.error);
      else router.refresh();
    });
  }

  function describe(template: TaskTemplate): string {
    if (template.recurrence === "daily") return t("everyDay");
    if (template.recurrence === "weekly") {
      return t("everyWeek", { day: t(`weekday_${template.weekday ?? 0}`) });
    }
    return t("everyMonth", { day: template.day_of_month ?? 1 });
  }

  return (
    <Panel>
      <PanelHeader
        title={t("templatesTitle")}
        subtitle={t("templatesSubtitle")}
        action={
          <Button variant="accent" size="sm" onClick={() => setEditing("new")}>
            <Plus size={12} />
            {t("addTemplate")}
          </Button>
        }
      />

      {error && (
        <p className="mb-3 text-xs font-medium text-[var(--color-accent-red)]">{error}</p>
      )}

      {templates.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">{t("templatesEmpty")}</p>
      ) : (
        <Table>
          <THead>
            <Th>{t("taskTitle")}</Th>
            <Th>{t("colWhen")}</Th>
            <Th>{t("colWho")}</Th>
            <Th>{t("colBranch")}</Th>
            <Th>{t("colStatus")}</Th>
            <Th className="text-end">{""}</Th>
          </THead>
          <TBody>
            {templates.map((template) => (
              <Tr key={template.id} className={template.active ? undefined : "opacity-55"}>
                <Td className="font-medium">
                  {template.title}
                  {template.active && templateDueOn(template, day) && (
                    <span className="ms-2 text-xs text-[var(--color-accent-green)]">
                      {t("dueToday")}
                    </span>
                  )}
                </Td>
                <Td className="text-[var(--color-text-muted)]">{describe(template)}</Td>
                <Td>
                  {template.assignee_id
                    ? (personName.get(template.assignee_id) ?? "—")
                    : template.assignee_role
                      ? t("everyRole", { role: roleName(template.assignee_role) })
                      : "—"}
                </Td>
                <Td className="text-[var(--color-text-muted)]">
                  {template.branch_id
                    ? (branchName.get(template.branch_id) ?? "—")
                    : t("everyBranch")}
                </Td>
                <Td>
                  <span
                    className={
                      template.active
                        ? "text-xs text-[var(--color-accent-green)]"
                        : "text-xs text-[var(--color-text-faint)]"
                    }
                  >
                    {template.active ? t("templateActive") : t("templateRetired")}
                  </span>
                </Td>
                <Td className="text-end">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditing(template)}>
                      <Pencil size={12} />
                      {t("edit")}
                    </Button>
                    <Button
                      variant={template.active ? "ghost" : "success"}
                      size="sm"
                      disabled={pending}
                      onClick={() => toggle(template)}
                    >
                      <RotateCcw size={12} />
                      {template.active ? t("retire") : t("restore")}
                    </Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {/* Retiring is not deleting, and the screen says so — a report from
          last week still points at the rule that produced it. */}
      <p className="mt-3 text-xs text-[var(--color-text-faint)]">{t("retireIsNotDelete")}</p>

      {editing && (
        <TemplateDialog
          template={editing === "new" ? null : editing}
          branches={branches}
          people={people}
          isCeo={isCeo}
          day={day}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}

function TemplateDialog({
  template,
  branches,
  people,
  isCeo,
  day,
  onClose,
}: {
  template: TaskTemplate | null;
  branches: Branch[];
  people: Person[];
  isCeo: boolean;
  day: string;
  onClose: () => void;
}) {
  const t = useTranslations("tasks");
  const roleName = useTranslations("roles");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(template?.title ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [recurrence, setRecurrence] = useState(template?.recurrence ?? "daily");
  const [weekday, setWeekday] = useState(template?.weekday ?? 0);
  const [dayOfMonth, setDayOfMonth] = useState(template?.day_of_month ?? 1);
  const [branchId, setBranchId] = useState<string>(
    template?.branch_id ?? branches[0]?.id ?? ""
  );
  const [everyBranch, setEveryBranch] = useState(
    template ? template.branch_id === null : false
  );
  const [aim, setAim] = useState<"role" | "person">(template?.assignee_id ? "person" : "role");
  const [assigneeRole, setAssigneeRole] = useState<string>(
    template?.assignee_role ?? "sales_exec"
  );
  const [assigneeId, setAssigneeId] = useState<string>(
    template?.assignee_id ?? people[0]?.id ?? ""
  );

  const candidates = useMemo(
    () =>
      people.filter(
        (p) => everyBranch || !branchId || p.branch_id === branchId || p.branch_id === null
      ),
    [people, branchId, everyBranch]
  );

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveTaskTemplate({
        id: template?.id,
        title,
        description,
        recurrence,
        weekday: recurrence === "weekly" ? weekday : null,
        day_of_month: recurrence === "monthly" ? dayOfMonth : null,
        branch_id: everyBranch ? null : branchId || null,
        assignee_role: aim === "role" ? assigneeRole : null,
        assignee_id: aim === "person" ? assigneeId : null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // See the panel header: a duty written this morning belongs on the
      // floor this morning. Failure here is invisible on purpose — the
      // template is saved either way and tomorrow's load would pick it up.
      await materialiseTasks({ day });
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={template ? t("editTemplate") : t("addTemplate")}>
        <div className="space-y-3">
          <div>
            <Label htmlFor="tpl-title">{t("taskTitle")}</Label>
            <Input
              id="tpl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={160}
            />
          </div>

          <div>
            <Label htmlFor="tpl-desc">{t("taskNote")}</Label>
            <Textarea
              id="tpl-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tpl-recurrence">{t("colWhen")}</Label>
              <Select
                id="tpl-recurrence"
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}
              >
                {RECURRENCES.map((r) => (
                  <option key={r} value={r}>
                    {t(`recurrence_${r}`)}
                  </option>
                ))}
              </Select>
            </div>

            {recurrence === "weekly" && (
              <div>
                <Label htmlFor="tpl-weekday">{t("onWeekday")}</Label>
                <Select
                  id="tpl-weekday"
                  value={String(weekday)}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {t(`weekday_${d}`)}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {recurrence === "monthly" && (
              <div>
                <Label htmlFor="tpl-dom">{t("onDayOfMonth")}</Label>
                <Select
                  id="tpl-dom"
                  value={String(dayOfMonth)}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                >
                  {Array.from({ length: MAX_DAY_OF_MONTH }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
                {/* Why the list stops at 28, said where the choice is made. */}
                <p className="mt-1 text-xs text-[var(--color-text-faint)]">
                  {t("dayOfMonthCap", { max: MAX_DAY_OF_MONTH })}
                </p>
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="tpl-branch">{t("colBranch")}</Label>
            <Select
              id="tpl-branch"
              value={branchId}
              disabled={everyBranch}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            {/* Company-wide is the CEO's alone — task_templates_insert
                refuses it for anybody else, so the control is simply not
                offered rather than offered and then rejected. */}
            {isCeo && (
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={everyBranch}
                  onChange={(e) => setEveryBranch(e.target.checked)}
                />
                {t("everyBranchOption")}
              </label>
            )}
          </div>

          <div>
            <Label>{t("colWho")}</Label>
            <div className="flex gap-4 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="tpl-aim"
                  checked={aim === "role"}
                  onChange={() => setAim("role")}
                />
                {t("aimAtRole")}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="tpl-aim"
                  checked={aim === "person"}
                  onChange={() => setAim("person")}
                />
                {t("aimAtPerson")}
              </label>
            </div>
            <div className="mt-2">
              {aim === "role" ? (
                <Select
                  value={assigneeRole}
                  onChange={(e) => setAssigneeRole(e.target.value)}
                >
                  {TARGET_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleName(r)}
                    </option>
                  ))}
                </Select>
              ) : (
                <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                  {candidates.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-3 text-xs font-medium text-[var(--color-accent-red)]">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || title.trim().length === 0}
            onClick={save}
          >
            {t("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
