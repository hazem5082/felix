"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea, Select } from "@/components/ui/input";
import { addLeadComment } from "../actions";

export function CommentForm({ leadId }: { leadId: string }) {
  const t = useTranslations("crm");
  const misc = useTranslations("misc");
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState("");
  const [method, setMethod] = useState("phone");

  function submit() {
    if (!body.trim()) return;
    startTransition(async () => {
      await addLeadComment({ lead_id: leadId, body, contact_method: method });
      setBody("");
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Select value={method} onChange={(e) => setMethod(e.target.value)} className="w-32">
          <option value="phone">{misc("contactMethodPhone")}</option>
          <option value="whatsapp">{misc("contactMethodWhatsapp")}</option>
          <option value="in_person">{misc("contactMethodInPerson")}</option>
          <option value="email">{misc("contactMethodEmail")}</option>
        </Select>
        <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={misc("whatHappened")} className="flex-1" />
      </div>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={submit} disabled={pending || !body.trim()}>
          {t("addComment")}
        </Button>
      </div>
    </div>
  );
}
