"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Pencil } from "lucide-react";
import type { Lead } from "@/lib/supabase/types";
import { NotePointsEditor } from "../note-points-editor";
import { updateLead } from "../actions";

/**
 * Corrects a client's details.
 *
 * Open to everyone who can open the lead. That is not a decision this
 * component makes — `leads_update` has permitted the owning salesperson,
 * their branch manager and the CEO since 0001, and the action re-checks
 * it server-side — but it is why there is no role prop here: a form
 * hidden from the person holding the phone is the reason wrong numbers
 * survived in the first place.
 *
 * `status`, the branch and the salesperson are absent on purpose. Those
 * are pipeline and ownership, moved by creating a deal ticket or by
 * reassigning the lead — not by the form used to fix a spelling.
 */
export function LeadEditFormDialog({ lead }: { lead: Lead }) {
  const t = useTranslations("crm");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const notes = useTranslations("notes");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const initial = {
    client_name: lead.client_name,
    phone_number: lead.phone_number,
    car_interest: lead.car_interest ?? "",
    address: lead.address ?? "",
    company_name: lead.company_name ?? "",
    job_title: lead.job_title ?? "",
    income: lead.income !== null ? String(lead.income) : "",
    client_notes: lead.client_notes ?? "",
    contact_time_preference: lead.contact_time_preference ?? "",
  };

  const [form, setForm] = useState(initial);
  const [points, setPoints] = useState<string[]>(lead.client_note_points ?? []);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Re-seeding from props on open, not on mount. The dialog's fields stay
  // mounted between openings, so an edit abandoned with Cancel would
  // otherwise still be sitting there the next time it is opened — and,
  // worse, would silently overwrite a change somebody else saved in the
  // meantime the moment this one was submitted.
  function change(next: boolean) {
    if (next) {
      setForm(initial);
      setPoints(lead.client_note_points ?? []);
      setError(null);
    }
    setOpen(next);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await updateLead({ id: lead.id, ...form, client_note_points: points });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil size={13} />
          {t("editClient")}
        </Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("editClient")}>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>{t("clientName")}</Label>
              <Input
                value={form.client_name}
                onChange={(e) => set("client_name", e.target.value)}
              />
            </div>
            <div>
              <Label>{t("phone")}</Label>
              <Input
                value={form.phone_number}
                onChange={(e) => set("phone_number", e.target.value)}
              />
            </div>
            <div>
              <Label>{t("carInterest")}</Label>
              <Input
                value={form.car_interest}
                onChange={(e) => set("car_interest", e.target.value)}
              />
            </div>
            <div>
              <Label>{misc("company")}</Label>
              <Input
                value={form.company_name}
                onChange={(e) => set("company_name", e.target.value)}
              />
            </div>
            <div>
              <Label>{misc("jobTitle")}</Label>
              <Input value={form.job_title} onChange={(e) => set("job_title", e.target.value)} />
            </div>
            <div>
              <Label>{misc("income")}</Label>
              <Input
                type="number"
                value={form.income}
                onChange={(e) => set("income", e.target.value)}
              />
            </div>
            <div>
              <Label>{misc("contactTime")}</Label>
              <Input
                value={form.contact_time_preference}
                onChange={(e) => set("contact_time_preference", e.target.value)}
                placeholder={misc("bestTimePlaceholder")}
              />
            </div>
            <div className="col-span-2">
              <Label>{misc("address")}</Label>
              <Input value={form.address} onChange={(e) => set("address", e.target.value)} />
            </div>
            <div className="col-span-2">
              <Label>{notes("heading")}</Label>
              <Textarea
                rows={2}
                value={form.client_notes}
                placeholder={notes("headingPlaceholder")}
                onChange={(e) => set("client_notes", e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <NotePointsEditor points={points} onChange={setPoints} disabled={pending} />
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => change(false)}>
              {common("cancel")}
            </Button>
            <Button
              variant="accent"
              onClick={submit}
              disabled={pending || !form.client_name.trim() || !form.phone_number.trim()}
            >
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
