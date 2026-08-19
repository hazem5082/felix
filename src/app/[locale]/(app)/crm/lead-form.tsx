"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Plus } from "lucide-react";
import { NotePointsEditor } from "./note-points-editor";
import { createLead } from "./actions";

export function LeadFormDialog() {
  const t = useTranslations("crm");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const notes = useTranslations("notes");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    client_name: "", phone_number: "", car_interest: "", address: "",
    company_name: "", job_title: "", income: "", client_notes: "",
  });
  // The bullets under the note — "needs seven seats", "bad roads, wants
  // an SUV". Held apart from `form` because it is a string[], and folding
  // it in would make the generic `set()` above lie about its value type.
  const [points, setPoints] = useState<string[]>([]);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createLead({ ...form, client_note_points: points });
      if ("error" in res) { setError(res.error); return; }
      setOpen(false);
      setForm({ client_name: "", phone_number: "", car_interest: "", address: "", company_name: "", job_title: "", income: "", client_notes: "" });
      setPoints([]);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm"><Plus size={14} />{t("addLead")}</Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("addLead")}>
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
            <Button variant="accent" onClick={submit} disabled={pending || !form.client_name || !form.phone_number}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
