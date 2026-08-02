"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { CalendarPlus } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toLocalInputValue } from "@/lib/calendar";
import type { Branch, InvitablePerson, Role } from "@/lib/supabase/types";
import { createMeeting } from "./actions";

/** Tomorrow at 10:00, rounded — a sane default for "schedule something". */
function defaultSlot(): { starts: string; ends: string } {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { starts: toLocalInputValue(start), ends: toLocalInputValue(end) };
}

export function MeetingFormDialog({
  people,
  branches,
  role,
}: {
  people: InvitablePerson[];
  branches: Branch[];
  role: Role;
}) {
  const t = useTranslations("calendar");
  const common = useTranslations("common");
  const roles = useTranslations("roles");

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const slot = useMemo(defaultSlot, []);
  const [form, setForm] = useState({
    title: "",
    agenda: "",
    location: "",
    starts_at: slot.starts,
    ends_at: slot.ends,
    branch_id: "",
  });
  const [invited, setInvited] = useState<string[]>([]);

  const isCeo = role === "ceo";

  // `people` is already exactly what create_meeting() will accept from
  // this caller — a branch manager is handed only their own branch's
  // sales staff — so grouping is presentation, not filtering.
  const grouped = useMemo(() => {
    const map = new Map<Role, InvitablePerson[]>();
    for (const p of people) {
      const list = map.get(p.role);
      if (list) list.push(p);
      else map.set(p.role, [p]);
    }
    return [...map.entries()];
  }, [people]);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggle(id: string) {
    setInvited((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  function reset() {
    const next = defaultSlot();
    setForm({
      title: "",
      agenda: "",
      location: "",
      starts_at: next.starts,
      ends_at: next.ends,
      branch_id: "",
    });
    setInvited([]);
    setError(null);
  }

  function submit() {
    setError(null);

    // A cleared datetime-local reports "", and new Date("").toISOString()
    // throws RangeError. Thrown inside startTransition it escapes to the
    // route's error boundary — the whole page crashes instead of the
    // dialog showing a message. Validate before entering the transition.
    const starts = new Date(form.starts_at);
    const ends = new Date(form.ends_at);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      setError(t("invalidDates"));
      return;
    }

    startTransition(async () => {
      const res = await createMeeting({
        ...form,
        // datetime-local gives wall-clock text with no zone; the Date
        // constructor reads it in the browser's zone, which is the one
        // the user typed it in.
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        branch_id: isCeo && form.branch_id ? form.branch_id : null,
        invitee_ids: invited,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      reset();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="accent" size="sm">
          <CalendarPlus size={14} />
          {t("newMeeting")}
        </Button>
      </DialogTrigger>

      {open && (
        <DialogContent title={t("newMeeting")}>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>{t("meetingTitle")}</Label>
              <Input value={form.title} onChange={(e) => set("title", e.target.value)} />
            </div>

            <div>
              <Label>{t("starts")}</Label>
              <Input
                type="datetime-local"
                value={form.starts_at}
                onChange={(e) => set("starts_at", e.target.value)}
              />
            </div>
            <div>
              <Label>{t("ends")}</Label>
              <Input
                type="datetime-local"
                value={form.ends_at}
                onChange={(e) => set("ends_at", e.target.value)}
              />
            </div>

            <div className={isCeo ? undefined : "col-span-2"}>
              <Label>{t("location")}</Label>
              <Input value={form.location} onChange={(e) => set("location", e.target.value)} />
            </div>

            {/* A branch manager's meeting is pinned to their own branch
                server-side, so the choice only exists for a CEO. */}
            {isCeo && (
              <div>
                <Label>{t("scope")}</Label>
                <Select value={form.branch_id} onChange={(e) => set("branch_id", e.target.value)}>
                  <option value="">{t("wholeShowroom")}</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="col-span-2">
              <Label>{t("agenda")}</Label>
              <Textarea rows={2} value={form.agenda} onChange={(e) => set("agenda", e.target.value)} />
            </div>

            <div className="col-span-2">
              <div className="mb-1.5 flex items-center justify-between">
                <Label className="mb-0">
                  {t("invitees")}{" "}
                  {invited.length > 0 && (
                    <span className="num text-[var(--color-accent-blue)]">({invited.length})</span>
                  )}
                </Label>
                {people.length > 0 && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setInvited(people.map((p) => p.id))}
                      className="rounded-md px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {t("selectAll")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setInvited([])}
                      className="rounded-md px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {t("clearAll")}
                    </button>
                  </div>
                )}
              </div>

              {!isCeo && (
                <p className="mb-2 text-[11px] text-[var(--color-text-faint)]">
                  {t("managerScopeNotice")}
                </p>
              )}

              <div className="max-h-52 space-y-3 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02] p-3">
                {grouped.map(([groupRole, members]) => (
                  <div key={groupRole}>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                      {roles(groupRole)}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {members.map((p) => {
                        const on = invited.includes(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => toggle(p.id)}
                            aria-pressed={on}
                            className={cn(
                              "rounded-lg border px-2.5 py-1 text-xs transition-all duration-200",
                              on
                                ? "border-cyan-400/60 bg-cyan-500/15 text-white"
                                : "border-white/10 bg-white/[0.03] text-[var(--color-text-muted)] hover:border-white/25 hover:text-white"
                            )}
                          >
                            {p.full_name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {!people.length && (
                  <p className="text-xs text-[var(--color-text-faint)]">{t("noInvitees")}</p>
                )}
              </div>
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button
              variant="accent"
              onClick={submit}
              disabled={
                pending ||
                !form.title.trim() ||
                !form.starts_at ||
                !form.ends_at ||
                invited.length === 0
              }
            >
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
