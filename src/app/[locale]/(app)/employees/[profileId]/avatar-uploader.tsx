"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Camera, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadFile } from "@/lib/upload-client";
import { updateEmployeeAvatar } from "../actions";

/**
 * Change / remove the profile photo. Rendered only for the owner and
 * the CEO; profiles_update_self is the gate that actually holds.
 */
export function AvatarUploader({
  profileId,
  hasPhoto,
}: {
  profileId: string;
  hasPhoto: boolean;
}) {
  const t = useTranslations("employees");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError(t("photoNotImage"));
      return;
    }
    startTransition(async () => {
      try {
        const url = await uploadFile(file, "avatars");
        const res = await updateEmployeeAvatar({ profile_id: profileId, avatar_url: url });
        if (res && "error" in res) {
          setError(res.error);
          return;
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("photoUploadFailed"));
      }
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const res = await updateEmployeeAvatar({ profile_id: profileId, avatar_url: "" });
      if (res && "error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
        >
          <Camera size={12} />
          {pending ? t("photoUploading") : t("changePhoto")}
        </Button>
        {hasPhoto && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={remove}>
            <Trash2 size={12} />
          </Button>
        )}
      </div>
      {error && <p className="max-w-40 text-center text-xs text-[var(--color-accent-red)]">{error}</p>}
    </div>
  );
}
