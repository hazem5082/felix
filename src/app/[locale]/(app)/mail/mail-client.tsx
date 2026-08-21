"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, Mail, Paperclip, Send, X } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isFelixMailAddress } from "@/lib/mail-address";
import { uploadMailAttachment } from "@/lib/upload-client";
import { markMailRead, sendMail } from "./actions";
import type { MailAttachment, MailMessage, Role } from "@/lib/supabase/types";

type ReceivedMessage = MailMessage & { is_read: boolean };
type Colleague = {
  id: string;
  full_name: string;
  role: Role;
  mail_address: string | null;
  avatar_url: string | null;
};
type OwnProfile = {
  id: string;
  full_name: string;
  role: Role;
  avatar_url: string | null;
  mail_address: string | null;
};

interface Props {
  sent: MailMessage[];
  received: ReceivedMessage[];
  attachments: MailAttachment[];
  colleagues: Colleague[];
  ownProfile: OwnProfile;
}

type Folder = "inbox" | "sent";

/**
 * Two panes, Outlook-style: the folder's messages down one side, the open
 * message beside them. The list IS the navigation, so it has to stay on
 * screen while you read — the previous single-column layout stacked the
 * message below the list, which meant every message you opened scrolled
 * the list out of view and every "next one" scrolled back up to find it.
 *
 * Below `lg` there is no room for both, so whichever pane matters swaps
 * in: the list until you pick something, the message after that, with a
 * back arrow. Same components either way — only which one carries
 * `hidden` changes — so nothing is remounted or lost at the breakpoint.
 */
export function MailClient({ sent, received, attachments, colleagues, ownProfile }: Props) {
  const t = useTranslations("mail");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [localReceived, setLocalReceived] = useState(received);
  const [, startTransition] = useTransition();

  const list = folder === "inbox" ? localReceived : sent;
  const unreadCount = localReceived.filter((m) => !m.is_read).length;
  const selected = list.find((m) => m.id === selectedId) ?? null;

  function openMessage(message: ReceivedMessage | MailMessage) {
    setSelectedId(message.id);
    if (folder === "inbox" && "is_read" in message && !message.is_read) {
      setLocalReceived((rows) => rows.map((r) => (r.id === message.id ? { ...r, is_read: true } : r)));
      startTransition(() => {
        markMailRead({ message_ids: [message.id], is_read: true });
      });
    }
  }

  function switchFolder(next: Folder) {
    setFolder(next);
    // Message ids are unique across folders, so a selection carried over
    // would just resolve to nothing and leave the reading pane blank.
    // Clearing it lands the new folder in its list state instead.
    setSelectedId(null);
  }

  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, MailAttachment[]>();
    for (const a of attachments) {
      const list = map.get(a.message_id) ?? [];
      list.push(a);
      map.set(a.message_id, list);
    }
    return map;
  }, [attachments]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          <FolderTab active={folder === "inbox"} onClick={() => switchFolder("inbox")}>
            {t("inbox")}
            {unreadCount > 0 && (
              <span className="ml-1.5 rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {unreadCount}
              </span>
            )}
          </FolderTab>
          <FolderTab active={folder === "sent"} onClick={() => switchFolder("sent")}>
            {t("sent")}
          </FolderTab>
        </div>

        <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Send size={14} /> {t("compose")}
            </Button>
          </DialogTrigger>
          {/* DialogContent force-mounts (see components/ui/dialog.tsx) so
              AnimatePresence can play its own exit animation — it has no
              CSS gate of its own for the closed state, so IT, not just the
              Dialog root's `open` prop, must be conditionally rendered.
              Every other dialog in the app does this; this one didn't,
              which is why it rendered open from first paint and the X
              button had nothing to actually unmount. */}
          {composeOpen && (
            <DialogContent title={t("compose")} className="max-w-2xl">
              <ComposeForm colleagues={colleagues} ownProfile={ownProfile} onSent={() => setComposeOpen(false)} />
            </DialogContent>
          )}
        </Dialog>
      </div>

      {/* A fixed-height row rather than a growing one: both panes scroll
          internally, so the toolbar above stays put and the page itself
          never gets a second scrollbar. Height is only pinned from `lg`,
          where the two-pane layout actually applies. */}
      <div className="flex gap-4 lg:h-[calc(100vh-16rem)] lg:min-h-[30rem]">
        {/* ── The list ─────────────────────────────────────── */}
        <Panel
          className={cn(
            "w-full flex-col overflow-hidden p-0 lg:flex lg:w-[21rem] lg:shrink-0 xl:w-[25rem]",
            selected ? "hidden" : "flex"
          )}
        >
          {list.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">
              {folder === "inbox" ? t("emptyInbox") : t("emptySent")}
            </p>
          ) : (
            <ul className="flex-1 divide-y divide-[var(--color-border)] overflow-y-auto">
              {list.map((m) => {
                const unread = folder === "inbox" && "is_read" in m && !m.is_read;
                const active = m.id === selectedId;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => openMessage(m)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                        active ? "bg-[var(--color-accent-dim)]" : "hover:bg-black/[0.02]"
                      )}
                    >
                      <Mail
                        size={15}
                        className={unread ? "mt-0.5 text-[var(--color-accent)]" : "mt-0.5 text-[var(--color-text-faint)]"}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className={`truncate text-sm ${unread ? "font-semibold text-[var(--color-text)]" : "text-[var(--color-text)]"}`}>
                            {folder === "inbox" ? m.from_name || m.from_address : m.to_addresses.join(", ") || t("noRecipients")}
                          </p>
                          {/* Date only. The full timestamp still shows in
                              the reading pane, and in a column this narrow
                              it crowded out the sender's name. */}
                          <span className="shrink-0 text-xs text-[var(--color-text-faint)]">
                            {new Date(m.occurred_at).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="truncate text-sm text-[var(--color-text-muted)]">{m.subject || t("noSubject")}</p>
                        <p className="truncate text-xs text-[var(--color-text-faint)]">{m.snippet}</p>
                      </div>
                      {folder === "sent" && m.send_status && m.send_status !== "sent" && (
                        <span className="shrink-0 rounded-full bg-[var(--color-accent-red-dim)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent-red)]">
                          {t(`sendStatus_${m.send_status}`)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* ── The reading pane ─────────────────────────────── */}
        <div className={cn("min-w-0 flex-1", selected ? "block" : "hidden lg:block")}>
          {selected ? (
            <MessageDetail
              message={selected}
              attachments={attachmentsByMessage.get(selected.id) ?? []}
              onClose={() => setSelectedId(null)}
              isOwnMessage={selected.sender_profile_id === ownProfile.id}
            />
          ) : (
            <Panel className="flex h-full items-center justify-center">
              <p className="flex flex-col items-center gap-2 text-sm text-[var(--color-text-muted)]">
                <Mail size={22} className="text-[var(--color-text-faint)]" />
                {t("selectMessage")}
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function FolderTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center rounded-[5px] px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function MessageDetail({
  message,
  attachments,
  onClose,
  isOwnMessage,
}: {
  message: MailMessage;
  attachments: MailAttachment[];
  onClose: () => void;
  isOwnMessage: boolean;
}) {
  const t = useTranslations("mail");
  return (
    <Panel className="flex h-full flex-col overflow-hidden">
      <div className="mb-3 flex items-start justify-between gap-3 border-b border-[var(--color-border)] pb-3">
        <div className="flex min-w-0 items-start gap-2">
          {/* Below lg the list is hidden while a message is open, so this
              arrow is the only way back to it. From lg up the list never
              went anywhere and the X beside it clears the pane instead —
              two affordances, one handler, whichever one the width has. */}
          <button
            onClick={onClose}
            aria-label={t("backToList")}
            className="-ms-1 shrink-0 rounded-md p-1 text-[var(--color-text-muted)] hover:bg-black/[0.05] lg:hidden"
          >
            <ArrowLeft size={16} className="rtl:-scale-x-100" />
          </button>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[var(--color-text)]">{message.subject || t("noSubject")}</h3>
            <p className="text-xs text-[var(--color-text-muted)]">
              {isOwnMessage
                ? `${t("to")}: ${message.to_addresses.join(", ") || t("noRecipients")}`
                : `${t("from")}: ${message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}`}
            </p>
            {message.cc_addresses.length > 0 && (
              <p className="text-xs text-[var(--color-text-faint)]">
                {t("cc")}: {message.cc_addresses.join(", ")}
              </p>
            )}
            <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
              {new Date(message.occurred_at).toLocaleString()}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label={t("closeMessage")}
          className="hidden shrink-0 rounded-md p-1 text-[var(--color-text-muted)] hover:bg-black/[0.05] lg:block"
        >
          <X size={16} />
        </button>
      </div>

      {/* body_html is a stranger's markup for an inbound message. Never
          rendered as HTML — the plain-text side is always what shows,
          same rule the 508.world Agent Portal's mail.js documents. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text)]">
          {message.body_text || message.snippet}
        </p>
      </div>

      {attachments.length > 0 && (
        <div className="mt-4 flex shrink-0 flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
          {attachments.map((a) => (
            <a
              key={a.id}
              href={`/api/mail/attachment/${a.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text)] hover:bg-black/[0.03]"
            >
              <Paperclip size={12} />
              {a.filename}
              <span className="text-[var(--color-text-faint)]">({Math.ceil(a.size_bytes / 1024)} KB)</span>
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}

interface PendingAttachment {
  key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}

/** Profile photo, or an initials fallback — same pattern as the employee profile page. */
function Avatar({ name, url, size = 24 }: { name: string; url: string | null; size?: number }) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={name}
        width={size}
        height={size}
        className="shrink-0 rounded-full border border-[var(--color-border)] object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] font-bold text-[var(--color-text-muted)]"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4) }}
    >
      {initialsOf(name) || "?"}
    </div>
  );
}

/**
 * An input box that filters the colleague list as you type and lets you
 * pick more than one — replaces the native `<select multiple>`, which
 * needed a modifier-click to multi-select and had no room for a photo.
 * Picking a row adds it to the chip list above the input; the dropdown
 * only ever offers people not already selected.
 *
 * What it offers is this showroom's staff and nobody else's — the query
 * behind `colleagues` runs against the session's own tenant schema, so
 * the address book is corporation-scoped by construction rather than by
 * a filter someone could drop (see page.tsx). Each row reads
 * "CEO - alex.carter.demo@felixmail.508.world", and the role is part of
 * what the search matches, so "accountant" finds the accountant without
 * anyone having to remember whose job that is.
 */
function RecipientPicker({
  colleagues,
  selectedIds,
  onChange,
  placeholder,
  emptyLabel,
}: {
  colleagues: Colleague[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
  emptyLabel: string;
}) {
  const roles = useTranslations("roles");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = colleagues.filter((c) => selectedIds.includes(c.id));
  const available = colleagues.filter((c) => !selectedIds.includes(c.id));
  const q = query.trim().toLowerCase();
  const matches = q
    ? available.filter(
        (c) =>
          c.full_name.toLowerCase().includes(q) ||
          roles(c.role).toLowerCase().includes(q) ||
          (c.mail_address ?? "").toLowerCase().includes(q)
      )
    : available;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function add(id: string) {
    onChange([...selectedIds, id]);
    setQuery("");
  }
  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex min-h-9.5 w-full flex-wrap items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1.5 focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15">
        {selected.map((c) => (
          <span
            key={c.id}
            title={`${roles(c.role)} - ${c.mail_address}`}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent-dim)] py-0.5 ps-1 pe-2 text-xs text-[var(--color-text)]"
          >
            <Avatar name={c.full_name} url={c.avatar_url} size={18} />
            {c.full_name}
            <span className="text-[var(--color-text-muted)]">· {roles(c.role)}</span>
            <button
              type="button"
              onClick={() => remove(c.id)}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-accent-red)]"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={selected.length === 0 ? placeholder : undefined}
          className="min-w-24 flex-1 border-none bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
        />
      </div>

      {open && (
        <ul className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_12px_30px_rgba(23,26,33,0.15)]">
          {matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-[var(--color-text-faint)]">{emptyLabel}</li>
          )}
          {matches.map((c) => (
            <li
              key={c.id}
              // pointerdown, not click: the input would blur first and
              // close the list before a click ever landed on the row.
              onPointerDown={(e) => {
                e.preventDefault();
                add(c.id);
              }}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-black/[0.04]"
            >
              <Avatar name={c.full_name} url={c.avatar_url} size={22} />
              <div className="min-w-0 flex-1">
                <p className="truncate">{c.full_name}</p>
                <p className="truncate text-xs text-[var(--color-text-faint)]">
                  <span className="font-medium text-[var(--color-text-muted)]">{roles(c.role)}</span>
                  {" - "}
                  {c.mail_address}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ComposeForm({
  colleagues,
  ownProfile,
  onSent,
}: {
  colleagues: Colleague[];
  ownProfile: OwnProfile;
  onSent: () => void;
}) {
  const t = useTranslations("mail");
  const roles = useTranslations("roles");
  const [toIds, setToIds] = useState<string[]>([]);
  const [ccIds, setCcIds] = useState<string[]>([]);
  const [externalTo, setExternalTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Files the user picked that never made it to storage. Kept separate
  // from `error`, which any later action would clear — a dropped
  // attachment has to outlive the message that announced it.
  const [failedUploads, setFailedUploads] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    setFailedUploads([]);
    // Per file, not one try around the loop: one failure used to abandon
    // every file after it as well, silently.
    for (const file of Array.from(files)) {
      try {
        const result = await uploadMailAttachment(file);
        setAttachments((prev) => [...prev, result]);
      } catch (err) {
        setFailedUploads((prev) => [...prev, file.name]);
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    }
    setUploading(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // A file that failed to upload must not leave quietly. Previously the
    // upload error was shown and then the send went ahead anyway with
    // whatever HAD uploaded — so a message written around an attachment
    // went out without it, and nothing in the sent copy said so.
    if (failedUploads.length) {
      setError(t("attachmentFailed", { files: failedUploads.join(", ") }));
      return;
    }

    const externalAddresses = externalTo
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Named before the round trip rather than after it. sendMail applies
    // the same rule from the same module and IS the one that counts —
    // this only spares the wait.
    if (externalAddresses.some(isFelixMailAddress)) {
      setError(t("externalNotFelix"));
      return;
    }

    startTransition(async () => {
      const res = await sendMail({
        to_profile_ids: toIds,
        cc_profile_ids: ccIds,
        to_external: externalAddresses,
        cc_external: [],
        subject,
        body,
        attachments: attachments.map((a) => ({
          key: a.key,
          filename: a.filename,
          mime_type: a.mimeType,
          size_bytes: a.sizeBytes,
        })),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onSent();
      window.location.reload();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && (
        <p className="rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red-dim)] px-3 py-2 text-sm text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
        <Avatar name={ownProfile.full_name} url={ownProfile.avatar_url} size={28} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--color-text)]">{ownProfile.full_name}</p>
          <p className="truncate text-xs text-[var(--color-text-faint)]">
            <span className="font-medium text-[var(--color-text-muted)]">{roles(ownProfile.role)}</span>
            {" - "}
            {ownProfile.mail_address}
          </p>
        </div>
      </div>

      <div>
        <Label>{t("toColleagues")}</Label>
        <RecipientPicker
          colleagues={colleagues}
          selectedIds={toIds}
          onChange={setToIds}
          placeholder={t("pickColleagues")}
          emptyLabel={t("noMatches")}
        />
      </div>

      <div>
        <Label>{t("ccColleagues")}</Label>
        <RecipientPicker
          colleagues={colleagues}
          selectedIds={ccIds}
          onChange={setCcIds}
          placeholder={t("pickColleagues")}
          emptyLabel={t("noMatches")}
        />
      </div>

      <div>
        <Label>{t("toExternal")}</Label>
        <Input
          placeholder="someone@example.com, another@example.com"
          value={externalTo}
          onChange={(e) => setExternalTo(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-text-faint)]">{t("externalHint")}</p>
      </div>

      <div>
        <Label>{t("subject")}</Label>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={300} />
      </div>

      <div>
        <Label>{t("message")}</Label>
        <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={50_000} />
      </div>

      <div>
        <Label>{t("attachments")}</Label>
        <input
          type="file"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          disabled={uploading}
          className="block w-full text-sm text-[var(--color-text-muted)] file:mr-3 file:rounded-md file:border file:border-[var(--color-border-strong)] file:bg-[var(--color-surface)] file:px-3 file:py-1.5 file:text-xs file:text-[var(--color-text)]"
        />
        {failedUploads.length > 0 && (
          <ul className="mt-2 space-y-1">
            {failedUploads.map((name) => (
              <li key={name} className="flex items-center gap-2 text-xs text-[var(--color-accent-red)]">
                <Paperclip size={12} />
                <span className="line-through">{name}</span>
                {t("attachmentNotAttached")}
                <button
                  type="button"
                  onClick={() => setFailedUploads((prev) => prev.filter((x) => x !== name))}
                  className="hover:underline"
                >
                  {t("remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachments.length > 0 && (
          <ul className="mt-2 space-y-1">
            {attachments.map((a) => (
              <li key={a.key} className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <Paperclip size={12} />
                {a.filename}
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                  className="text-[var(--color-accent-red)] hover:underline"
                >
                  {t("remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={pending || uploading}>
          <Send size={14} /> {pending ? t("sending") : t("send")}
        </Button>
      </div>
    </form>
  );
}
