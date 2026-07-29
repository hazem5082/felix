"use client";

import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Panel } from "@/components/ui/panel";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { submitPublicLead } from "./actions";
import { CheckCircle2 } from "lucide-react";

export function ReferralForm({ salespersonId }: { salespersonId: string }) {
  const misc = useTranslations("misc");
  const crm = useTranslations("crm");
  const common = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await submitPublicLead(salespersonId, formData);
      if (res.error) { setError(res.error); return; }
      setDone(true);
    });
  }

  if (done) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm text-center">
        <CheckCircle2 className="mx-auto mb-3 text-[var(--color-accent-green)]" size={40} />
        <h1 className="text-lg font-semibold">{misc("thanksMessage")}</h1>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm">
      <div className="mb-5 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--color-border-strong)] bg-gradient-to-b from-[#3a3f47] to-[#1c1e22] text-sm font-bold tracking-widest text-white">
          FX
        </div>
        <h1 className="text-lg font-semibold">{misc("referralHeading")}</h1>
      </div>
      <Panel raised>
        <form action={submit} className="space-y-3">
          <div>
            <Label htmlFor="client_name">{misc("fullName")}</Label>
            <Input id="client_name" name="client_name" required />
          </div>
          <div>
            <Label htmlFor="phone_number">{misc("phoneNumber")}</Label>
            <Input id="phone_number" name="phone_number" required />
          </div>
          <div>
            <Label htmlFor="car_interest">{crm("carInterest")}</Label>
            <Input id="car_interest" name="car_interest" placeholder={misc("carInterestPlaceholder")} />
          </div>
          <div>
            <Label htmlFor="contact_time_preference">{misc("bestTimeToContact")}</Label>
            <Input id="contact_time_preference" name="contact_time_preference" placeholder={misc("bestTimePlaceholder")} />
          </div>
          <div>
            <Label htmlFor="client_notes">{misc("anythingElse")}</Label>
            <Textarea id="client_notes" name="client_notes" rows={2} />
          </div>
          {error && <p className="text-xs text-[var(--color-accent-red)]">{error}</p>}
          <Button type="submit" variant="accent" className="w-full" disabled={pending}>
            {pending ? misc("submitting") : common("submit")}
          </Button>
        </form>
      </Panel>
    </motion.div>
  );
}
