"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Plus, Upload } from "lucide-react";
import { uploadFile } from "@/lib/upload-client";
import { createFinancingPartner } from "./actions";

export function PartnerFormDialog() {
  const t = useTranslations("accountant");
  const common = useTranslations("common");
  const misc = useTranslations("misc");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [bankName, setBankName] = useState("");
  const [productName, setProductName] = useState("");
  const [rate, setRate] = useState("");
  const [term, setTerm] = useState("");
  const [minDown, setMinDown] = useState("");
  const [contractUrl, setContractUrl] = useState<string | null>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadFile(file, "financing-contracts");
      setContractUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createFinancingPartner({
        bank_name: bankName,
        product_name: productName,
        rate,
        term_months: term,
        min_down_payment: minDown,
        contract_file_url: contractUrl,
      });
      if (res.error) { setError(res.error); return; }
      setOpen(false);
      setBankName(""); setProductName(""); setRate(""); setTerm(""); setMinDown(""); setContractUrl(null);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="accent" size="sm"><Plus size={14} />{t("addPartner")}</Button>
      </DialogTrigger>
      {open && (
        <DialogContent title={t("addPartner")}>
          <div className="space-y-3">
            <div>
              <Label>{t("bankName")}</Label>
              <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
            </div>
            <div>
              <Label>{t("productName")}</Label>
              <Input value={productName} onChange={(e) => setProductName(e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>{t("rate")} %</Label>
                <Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} />
              </div>
              <div>
                <Label>{t("termMonths")}</Label>
                <Input type="number" value={term} onChange={(e) => setTerm(e.target.value)} />
              </div>
              <div>
                <Label>{misc("minDown")}</Label>
                <Input type="number" value={minDown} onChange={(e) => setMinDown(e.target.value)} />
              </div>
            </div>

            <div>
              <Label>Bank contract file</Label>
              <p className="mb-1.5 text-xs text-[var(--color-accent-amber)]">{t("uploadContractPrompt")}</p>
              <label className="flex h-16 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent-blue)]/50">
                <Upload size={14} />
                {uploading ? common("uploading") : contractUrl ? t("contractUploaded") : common("upload")}
                <input type="file" accept="application/pdf,image/*" className="hidden" onChange={handleUpload} />
              </label>
            </div>
          </div>
          {error && <p className="mt-3 text-xs text-[var(--color-accent-red)]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{common("cancel")}</Button>
            <Button variant="accent" onClick={submit} disabled={pending || !bankName || !productName}>
              {common("save")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
