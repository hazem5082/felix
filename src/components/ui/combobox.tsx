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
          className="h-9.5 w-full rounded-xl border border-white/15 bg-white/[0.04] backdrop-blur-md ps-3.5 pe-9 text-sm text-white placeholder:text-white/40 outline-none transition-all duration-200 focus:border-cyan-400/60 focus:bg-white/[0.07] focus:ring-4 focus:ring-cyan-500/15 shadow-[inset_0_1px_3px_rgba(0,0,0,0.4)] disabled:opacity-60"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Toggle list"
          disabled={disabled}
          onClick={() => (open ? close() : setOpen(true))}
          className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-white/40 hover:text-white/80"
        >
          <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && !disabled && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-white/15 bg-[#12151b] py-1 shadow-[0_18px_50px_rgba(0,0,0,0.65)]"
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
                "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-white/90",
                i === active && "bg-white/10",
                o.value === value && "text-cyan-300"
              )}
            >
              {o.swatch && (
                <span
                  aria-hidden
                  className="size-3.5 shrink-0 rounded-full border border-white/25"
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
