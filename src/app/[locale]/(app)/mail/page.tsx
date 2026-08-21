import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { PanelHeader } from "@/components/ui/panel";
import type { MailAttachment, MailMessage, MailRecipient } from "@/lib/supabase/types";
import { MailClient } from "./mail-client";

/**
 * FELIX mail (0039). One page: compose, inbox, sent — no separate
 * routes, because a mail client is one continuous surface a person
 * moves through, not three destinations.
 *
 * Two queries, not a role-gated join: "sent" is a straight filter on
 * mail_messages, "received" goes through mail_recipients because that
 * is where per-person is_read actually lives (see migration 0039's
 * header for why to_addresses/cc_addresses is a display list and not
 * the visibility mechanism). Both are already exactly what RLS would
 * return with no filter at all — mail_messages_select and
 * mail_recipients_select already scope to "mine" — so the .eq() calls
 * below are for query shape, not security.
 */
export default async function MailPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const profile = await requireProfile(locale);
  const t = await getTranslations("mail");

  const supabase = await createClient();

  const [{ data: sentRows }, { data: receivedRows }, { data: colleagueRows }] = await Promise.all([
    supabase
      .from("mail_messages")
      .select("*")
      .eq("sender_profile_id", profile.id)
      .order("occurred_at", { ascending: false })
      .limit(100),
    supabase
      .from("mail_recipients")
      .select("is_read, message:mail_messages(*)")
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("profiles")
      .select("id, full_name, mail_address")
      .neq("id", profile.id)
      .order("full_name"),
  ]);

  const sent = (sentRows as MailMessage[] | null) ?? [];
  const received = (
    (receivedRows as { is_read: boolean; message: MailMessage | null }[] | null) ?? []
  )
    .filter((r): r is { is_read: boolean; message: MailMessage } => r.message !== null)
    .map((r) => ({ ...r.message, is_read: r.is_read }));

  const messageIds = [...sent.map((m) => m.id), ...received.map((m) => m.id)];
  const { data: attachmentRows } = messageIds.length
    ? await supabase.from("mail_attachments").select("*").in("message_id", messageIds)
    : { data: [] as MailAttachment[] };

  const colleagues = (
    (colleagueRows as { id: string; full_name: string; mail_address: string | null }[] | null) ?? []
  ).filter((c) => c.mail_address);

  return (
    <div className="space-y-6">
      <PanelHeader title={t("title")} subtitle={profile.mail_address ?? t("noAddressYet")} />
      <MailClient
        sent={sent}
        received={received}
        attachments={(attachmentRows as MailAttachment[] | null) ?? []}
        colleagues={colleagues}
        ownProfileId={profile.id}
      />
    </div>
  );
}

export type ReceivedMessage = MailMessage & { is_read: boolean };
export type { MailRecipient };
