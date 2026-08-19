"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  /** The value stored on the record — canonical, never translated. */
  value: string;
  /** What the user reads. May be localised. */
  label: string;
  /** CSS colour for the leading dot, used by the colour picker. */
  swatch?: string;
  /** Arbitrary leading mark — the manufacturer badge on the make picker. */
  icon?: React.ReactNode;
}

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Shown in the list when nothing matches what was typed. */
  emptyLabel?: string;
  className?: string;
  id?: string;
}

/**
 * A text input that filters a list as you type but still accepts anything
 * you type — the combobox pattern, not a <select>.
 *
 * A native <select> could not do this job here. The make list is ~400 entries
 * and the model list is per-make, so the control has to be searchable; and
 * make/model/colour all have to accept a value that is not on the list at all
 * (a grey-import badge, a trim vPIC has never heard of, "Nardo Grey"), which a
 * <select> cannot express. It also lets the colour rows carry a swatch, which
 * <option> cannot: option content is painted by the platform and ignores
 * markup.
 *
 * The value is free text at every moment — picking a row is a shortcut, not a
 * constraint — so the parent never has to reconcile "selected option" against
 * "typed text".
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  loading,
  emptyLabel,
  className,
  id,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const generatedId = useId();
  const listId = `${id ?? generatedId}-listbox`;

  // `query` is null unless the user is actively typing, so the field shows the
  // committed value the rest of the time — including when the parent changes it
  // (clearing the model when the make changes).
  const text = query ?? displayFor(value, options);

  const matches = useMemo(() => {
    if (query === null || query.trim() === "") return options;
    const q = query.trim().toLowerCase();
    // Prefix matches first: typing "co" on Toyota should reach Corolla before
    // Land Cruiser, which also contains "co".
    const starts: ComboboxOption[] = [];
    const contains: ComboboxOption[] = [];
    for (const o of options) {
      const l = o.label.toLowerCase();
      if (l.startsWith(q)) starts.push(o);
      else if (l.includes(q) || o.value.toLowerCase().includes(q)) contains.push(o);
    }
    return [...starts, ...contains];
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function close() {
    setOpen(false);
    setQuery(null);
  }

  function commit(option: ComboboxOption) {
    onChange(option.value);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (matches.length ? (i + delta + matches.length) % matches.length : 0));
      return;
    }
    if (e.key === "Enter" && open && matches[active]) {
      // Only swallow Enter when it is actually choosing a row — otherwise the
      // dialog's own submit stays reachable from the keyboard.
      e.preventDefault();
      commit(matches[active]);
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") close();
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <div className="relative">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          value={loading ? "" : text}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-9.5 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] ps-3.5 pe-9 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none transition-colors duration-150 focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15 disabled:opacity-60"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Toggle list"
          disabled={disabled}
          onClick={() => (open ? close() : setOpen(true))}
          className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
        >
          <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && !disabled && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_12px_30px_rgba(23,26,33,0.15)]"
        >
          {matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-[var(--color-text-faint)]">
              {emptyLabel ?? "No matches"}
            </li>
          )}
          {matches.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              // pointerdown, not click: the input would blur first and close
              // the list before a click ever landed.
              onPointerDown={(e) => {
                e.preventDefault();
                commit(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text)]",
                i === active && "bg-black/[0.04]",
                o.value === value && "text-[var(--color-accent)]"
              )}
            >
              {o.swatch && (
                <span
                  aria-hidden
                  className="size-3.5 shrink-0 rounded-full border border-[var(--color-border-strong)]"
                  style={{ backgroundColor: o.swatch }}
                />
              )}
              {o.icon}
              <span className="truncate">{o.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function displayFor(value: string, options: ComboboxOption[]): string {
  if (!value) return "";
  return options.find((o) => o.value === value)?.label ?? value;
}
