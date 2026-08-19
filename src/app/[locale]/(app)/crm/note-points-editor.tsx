"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Plus, X } from "lucide-react";

/**
 * The bullets under a client's note.
 *
 * The heading — "married, three kids" — stays a textarea, because it is
 * a description and it reads as a paragraph. These are the separately
 * actionable requirements a salesperson has in front of them on a call:
 * "lives where the roads are bad, wants the ride height of an SUV",
 * "seven seats", "sport mode, leather, German-built". One input each, so
 * they can be added, reworded and removed one at a time.
 *
 * A row is a plain string in an array, keyed by index rather than by a
 * generated id. That is normally the wrong call — React reuses the DOM
 * node when the list is reordered — but there is no reordering here and
 * no per-row state to strand: the input is controlled by its value, and
 * the value is the entire row. A generated id would buy nothing and cost
 * a `useState` initialiser that has to stay in step with the parent's
 * array through resets.
 *
 * Empty rows are not policed. `notePoints` in validation.ts drops them
 * on the way in, so the last row can sit blank waiting to be typed into
 * without the form refusing to save.
 */
export function NotePointsEditor({
  points,
  onChange,
  disabled,
}: {
  points: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("notes");

  function set(index: number, value: string) {
    onChange(points.map((p, i) => (i === index ? value : p)));
  }

  function remove(index: number) {
    onChange(points.filter((_, i) => i !== index));
  }

  return (
    <div>
      <Label>{t("points")}</Label>
      <p className="mb-2 text-xs text-[var(--color-text-faint)]">{t("pointsHint")}</p>

      <div className="space-y-2">
        {points.map((point, index) => (
          <div key={index} className="flex items-center gap-2">
            <span aria-hidden className="text-[var(--color-text-faint)]">
              •
            </span>
            <Input
              value={point}
              disabled={disabled}
              placeholder={t("pointPlaceholder")}
              onChange={(e) => set(index, e.target.value)}
            />
            <button
              type="button"
              aria-label={t("removePoint")}
              disabled={disabled}
              onClick={() => remove(index)}
              className="cursor-pointer rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--color-text)] disabled:pointer-events-none disabled:opacity-40"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={disabled}
        onClick={() => onChange([...points, ""])}
      >
        <Plus size={13} />
        {t("addPoint")}
      </Button>
    </div>
  );
}

/**
 * The same bullets, read-only, for the client info panel.
 *
 * Renders nothing at all when a client has neither heading nor points —
 * an empty bordered box under every lead that nobody has written a note
 * about is noise on the page that matters most.
 */
export function NotePointsView({
  heading,
  points,
}: {
  heading: string | null;
  points: string[];
}) {
  const shown = points.filter((p) => p.trim());
  if (!heading?.trim() && !shown.length) return null;

  return (
    <div className="mt-3 rounded-lg bg-black/[0.02] p-3">
      {heading?.trim() && (
        <p className="text-xs font-medium text-[var(--color-text)]">{heading}</p>
      )}
      {shown.length > 0 && (
        <ul className={heading?.trim() ? "mt-2 space-y-1" : "space-y-1"}>
          {shown.map((point, index) => (
            <li
              key={index}
              className="flex gap-2 text-xs text-[var(--color-text-muted)]"
            >
              <span aria-hidden className="text-[var(--color-text-faint)]">
                •
              </span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
