"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Plus, UserRoundCheck } from "lucide-react";
import { NotePointsEditor } from "./note-points-editor";
import { createLead, lookupCustomerForLead } from "./actions";

/**
 * Egyptian national ID: exactly 14 digits when present (mirrors the DB
 * CHECK from migration 0020). Same shape as the employees form's helper,
 * exported for the edit dialog on the lead page.
 */
export function leadNationalIdInvalid(value: string) {
  const v = value.trim();
  return v !== "" && !/^[0-9]{14}$/.test(v);
}

export function LeadFormDialog() {
  const t = useTranslations("crm");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const notes = useTranslations("notes");
  const customer = useTranslations("customer");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    client_name: "", phone_number: "", car_interest: "", address: "",
    company_name: "", job_title: "", income: "", client_notes: "",
    // Buyer identity (0020) — optional at creation; the ID is usually
    // collected when the person is actually buying, not on first contact.
    national_id: "", nationality: "",
  });
  // The bullets under the note — "needs seven seats", "bad roads, wants
  // an SUV". Held apart from `form` because it is a string[], and folding
  // it in would make the generic `set()` above lie about its value type.
  const [points, setPoints] = useState<string[]>([]);

  // "We know this person already" (0031). Advisory only: it never blocks
  // the save, never pre-fills a field, and the link is decided again
  // server-side by createLead. Its whole job is to stop a salesperson
  // typing a second record for somebody the group already has.
  const [known, setKnown] = useState<{ full_name: string } | null>(null);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Debounced, because it watches two fields somebody is typing into, and
  // the cleanup drops the reply of any probe that has been superseded —
  // responses can land out of order, and a slow answer for a half-typed
  // number must not overwrite the answer for the complete one.
  //
  // Cheap enough to run while somebody types: at most two indexed queries
  // (the unique index on national_id, the GIN index on phone_numbers)
  // returning one name or nothing.
  const probeId = form.national_id.trim();
  const probePhone = form.phone_number.trim();
  useEffect(() => {
    if (!open) return;
    if (probePhone.length < 6 && !/^[0-9]{14}$/.test(probeId)) {
      setKnown(null);
      return;
    }

    let live = true;
    const timer = setTimeout(() => {
      lookupCustomerForLead({ national_id: probeId, phone_number: probePhone })
        .then((match) => {
          if (live) setKnown(match);
        })
        .catch(() => {
          // A failed probe is a missing courtesy, never a failed form.
          if (live) setKnown(null);
        });
    }, 400);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, probeId, probePhone]);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createLead({ ...form, client_note_points: points });
      if ("error" in res) { setError(res.error); return; }
      setOpen(false);
      setForm({ client_name: "", phone_number: "", car_interest: "", address: "", company_name: "", job_title: "", income: "", client_notes: "", national_id: "", nationality: "" });
      setPoints([]);
      setKnown(null);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm"><Plus size={14} />{t("addLead")}</Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("addLead")}>
          {/* Non-blocking, and placed above the fields rather than beside
              one of them: it is about the person, not about the national
              ID or the phone individually, and either can be what
              matched. */}
          {known && (
            <div className="mb-3 flex items-start gap-2 rounded-md bg-[var(--color-accent-blue-dim)] px-3 py-2 text-xs text-[var(--color-accent-blue)]">
              <UserRoundCheck size={14} className="mt-px shrink-0" />
              <span>{customer("existingMatch", { name: known.full_name })}</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>{t("clientName")}</Label>
              <Input value={form.client_name} onChange={(e) => set("client_name", e.target.value)} />
            </div>
            <div>
              <Label>{t("phone")}</Label>
              <Input value={form.phone_number} onChange={(e) => set("phone_number", e.target.value)} />
            </div>
            <div>
              <Label>{t("carInterest")}</Label>
              <Input value={form.car_interest} onChange={(e) => set("car_interest", e.target.value)} />
            </div>
            <div>
              <Label>{misc("company")}</Label>
              <Input value={form.company_name} onChange={(e) => set("company_name", e.target.value)} />
            </div>
            <div>
              <Label>{misc("jobTitle")}</Label>
              <Input value={form.job_title} onChange={(e) => set("job_title", e.target.value)} />
            </div>
            <div>
              <Label>{misc("income")}</Label>
              <Input type="number" value={form.income} onChange={(e) => set("income", e.target.value)} />
            </div>
            <div>
              <Label>{misc("address")}</Label>
              <Input value={form.address} onChange={(e) => set("address", e.target.value)} />
            </div>
            <div>
              <Label>{misc("nationalId")}</Label>
              <Input
                dir="ltr"
                maxLength={14}
                inputMode="numeric"
                value={form.national_id}
                onChange={(e) => set("national_id", e.target.value)}
              />
              {leadNationalIdInvalid(form.national_id) && (
                <p className="mt-1 text-xs text-[var(--color-accent-red)]">{misc("nationalIdInvalid")}</p>
              )}
            </div>
            <div>
              <Label>{misc("nationality")}</Label>
              <Input
                value={form.nationality}
                onChange={(e) => set("nationality", e.target.value)}
                placeholder={misc("nationalityPlaceholder")}
              />
            </div>
            <div className="col-span-2">
              <Label>{notes("heading")}</Label>
              <Textarea rows={2} value={form.client_notes} placeholder={notes("headingPlaceholder")} onChange={(e) => set("client_notes", e.target.value)} />
            </div>
            <div className="col-span-2">
              <NotePointsEditor points={points} onChange={setPoints} disabled={pending} />
            </div>
          </div>
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            <Button
              variant="accent"
              onClick={submit}
              disabled={pending || !form.client_name || !form.phone_number || leadNationalIdInvalid(form.national_id)}
            >
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
