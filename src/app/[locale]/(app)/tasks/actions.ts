"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { assertBranch, authenticate, authorize } from "@/lib/auth";
import { consume, LIMITS, retryMessage } from "@/lib/rate-limit";
import { toUserError } from "@/lib/db-error";
import { SIGNATURE_HTML, SIGNATURE_TEXT, snippetOf, textToHtml, threadKeyOf } from "@/lib/mail-body";
import { bucketDay, splitLeads, summariseDay, completionPercent } from "@/lib/tasks";
import {
  CreateTaskSchema,
  DistributeLeadsSchema,
  EndDaySchema,
  MaterialiseTasksSchema,
  SetTaskStatusSchema,
  SetTaskTemplateActiveSchema,
  TaskTemplateSchema,
  parseInput,
  type ActionError,
} from "@/lib/validation";
import type { DayReportRecipient, Profile, TaskRow } from "@/lib/supabase/types";

/**
 * The task board's writes (migration 0053).
 *
 * WHERE THE FENCES ACTUALLY ARE. Every action here opens with an
 * authorize() call, and none of them is the boundary — Postgres is.
 * tasks_insert admits a manager over their own branch or a person
 * writing their own to-do; task_templates_insert admits a manager over
 * a named branch and reserves the company-wide template for the CEO;
 * and a status change does not go through a policy at all, it goes
 * through set_task_status(), which decides for itself. This layer
 * exists to produce a readable error before the round trip, and to stop
 * a caller who has bypassed the UI from learning anything from the
 * difference between the two.
 *
 * WHY THERE IS NO "REASSIGN" ACTION. Moving a task from one person to
 * another silently rewrites what somebody was asked to do, after the
 * fact, in a table whose entire purpose is to say what somebody was
 * asked to do. A manager withdraws the task (status 'cancelled', which
 * the evening report excludes) and assigns a new one. Two rows, both
 * true.
 */

const MANAGER_ROLES = ["ceo", "branch_manager"] as const;

/**
 * Everyone a task can be given to. Investors are the omission, and it is
 * the same one attendance makes: they are outside capital, not staff,
 * and there is no sense in which one is assigned the morning call list.
 */
const TASK_ROLES = [
  "ceo",
  "branch_manager",
  "accountant",
  "sales_exec",
  "marketing",
  "hr",
] as const;

const TASKS_PATH = "/[locale]/(app)/tasks";

/**
 * Mint today's rows from whatever templates fall due.
 *
 * Called by the page on load rather than by a scheduler, because this
 * deployment has none inside Postgres — see migration 0053's header.
 * Exported as an action too so that creating a template can materialise
 * it immediately: a manager who writes "daily: ring your leads" at
 * 09:00 expects to see it on the floor at 09:01, not tomorrow.
 *
 * Never surfaces its own failure. The RPC is missing on a deployment
 * still on 0052, and a page that 500s because there was nothing to
 * create is worse than a page with an empty board.
 */
export async function materialiseTasks(input: {
  day: string;
}): Promise<{ ok: true; created: number } | ActionError> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(MaterialiseTasksSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("materialise_tasks", { p_day: parsed.data.day });
  if (error) {
    console.error("[tasks] materialise failed", error);
    return { ok: true, created: 0 };
  }

  revalidatePath(TASKS_PATH, "page");
  return { ok: true, created: Number(data ?? 0) };
}

/**
 * Create or amend a standing instruction.
 *
 * A COMPANY-WIDE TEMPLATE (branch_id null) IS THE CEO'S ALONE, and that
 * is refused here as well as by task_templates_insert. A branch manager
 * writing one would be reaching into branches they cannot otherwise
 * touch — the policy would refuse the row, but "that branch is not
 * yours" is a better answer than a bare permission error.
 */
export async function saveTaskTemplate(input: unknown): Promise<{ ok: true } | ActionError> {
  const auth = await authorize([...MANAGER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(TaskTemplateSchema, input);
  if (!parsed.ok) return parsed.error;
  const t = parsed.data;

  if (t.branch_id === null && auth.profile.role !== "ceo") {
    return {
      error: "Only the CEO can set a task for every branch. Pick a branch.",
      fieldErrors: { branch_id: ["Pick a branch."] },
    };
  }
  if (t.branch_id !== null) {
    const denied = await assertBranch(auth.profile, t.branch_id);
    if (denied) return denied;
  }

  const supabase = await createClient();

  // A named assignee must be somebody this session can already see.
  // profiles_select confines a branch manager to their own branch, so
  // this is not an extra fence so much as a readable failure for one
  // the database was going to apply anyway.
  if (t.assignee_id) {
    const { data: target } = await supabase
      .from("profiles")
      .select("id, role, branch_id")
      .eq("id", t.assignee_id)
      .maybeSingle();
    const person = target as Pick<Profile, "id" | "role" | "branch_id"> | null;
    if (!person) return { error: "That person is not in your showroom." };
    if (!(TASK_ROLES as readonly string[]).includes(person.role)) {
      return { error: "Investors are not assigned tasks." };
    }
  }

  const row = {
    title: t.title,
    description: t.description,
    recurrence: t.recurrence,
    // Cleared rather than carried: a template edited from weekly to
    // monthly must not keep a stale weekday that a later edit back to
    // weekly would silently resurrect.
    weekday: t.recurrence === "weekly" ? t.weekday : null,
    day_of_month: t.recurrence === "monthly" ? t.day_of_month : null,
    branch_id: t.branch_id,
    assignee_role: t.assignee_role,
    assignee_id: t.assignee_id,
    updated_at: new Date().toISOString(),
    updated_by: auth.profile.id,
  };

  const { error } = t.id
    ? await supabase.from("task_templates").update(row).eq("id", t.id)
    : await supabase
        .from("task_templates")
        .insert({ ...row, created_by: auth.profile.id });

  if (error) return toUserError(error);

  revalidatePath(TASKS_PATH, "page");
  return { ok: true };
}

/**
 * Retire a standing instruction, or bring it back.
 *
 * Retiring is `active = false` and never a delete: yesterday's tasks
 * keep pointing at the rule that produced them, so a report from last
 * week can still explain itself. The tenant role holds no DELETE on
 * this table in any case.
 */
export async function setTaskTemplateActive(
  input: unknown
): Promise<{ ok: true } | ActionError> {
  const auth = await authorize([...MANAGER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(SetTaskTemplateActiveSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase
    .from("task_templates")
    .update({
      active: parsed.data.active,
      updated_at: new Date().toISOString(),
      updated_by: auth.profile.id,
    })
    .eq("id", parsed.data.id);

  if (error) return toUserError(error);

  revalidatePath(TASKS_PATH, "page");
  return { ok: true };
}

/**
 * A one-off task: a manager assigning work, or anyone's own to-do.
 *
 * The two cases go down the same path and are separated by one thing —
 * whether `assignee_id` names somebody else. tasks_insert has an arm for
 * each, and the personal arm pins origin to 'manual' so that a to-do can
 * never impersonate a duty somebody was given.
 */
export async function createTask(input: unknown): Promise<{ ok: true } | ActionError> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;
  if (!(TASK_ROLES as readonly string[]).includes(auth.profile.role)) {
    return { error: "You do not have permission to perform this action." };
  }

  const parsed = await parseInput(CreateTaskSchema, input);
  if (!parsed.ok) return parsed.error;
  const data = parsed.data;

  const supabase = await createClient();
  const forSomeoneElse = data.assignee_id !== null && data.assignee_id !== auth.profile.id;

  let assigneeId = auth.profile.id;
  let branchId = auth.profile.branch_id;

  if (forSomeoneElse) {
    if (!(MANAGER_ROLES as readonly string[]).includes(auth.profile.role)) {
      return { error: "Only a manager can give a task to somebody else." };
    }
    const { data: target } = await supabase
      .from("profiles")
      .select("id, role, branch_id")
      .eq("id", data.assignee_id!)
      .maybeSingle();
    const person = target as Pick<Profile, "id" | "role" | "branch_id"> | null;
    if (!person) return { error: "That person is not in your showroom." };
    if (!(TASK_ROLES as readonly string[]).includes(person.role)) {
      return { error: "Investors are not assigned tasks." };
    }
    const denied = await assertBranch(auth.profile, person.branch_id);
    if (denied) return denied;
    assigneeId = person.id;
    branchId = person.branch_id;
  }

  const { error } = await supabase.from("tasks").insert({
    branch_id: branchId,
    assignee_id: assigneeId,
    title: data.title,
    description: data.description,
    due_on: data.due_on,
    origin: "manual",
    created_by: auth.profile.id,
  });

  if (error) return toUserError(error);

  revalidatePath(TASKS_PATH, "page");
  return { ok: true };
}

/**
 * Tick it, decline it, or (a manager only) withdraw it.
 *
 * Goes through set_task_status() rather than an UPDATE, because
 * tasks_update deliberately does not admit the assignee: they must be
 * able to change the STATUS of their task and nothing else about it.
 * See migration 0053's header — the RPC is the whole fence, and the
 * error it raises is what comes back here.
 */
export async function setTaskStatus(input: unknown): Promise<{ ok: true } | ActionError> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(SetTaskStatusSchema, input);
  if (!parsed.ok) return parsed.error;

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_task_status", {
    p_task_id: parsed.data.id,
    p_status: parsed.data.status,
    p_note: parsed.data.note ?? "",
  });

  if (error) return toUserError(error);

  revalidatePath(TASKS_PATH, "page");
  return { ok: true };
}

export interface DistributeResult {
  ok: true;
  /** Follow-up tasks created — never more than one per enquiry per day. */
  created: number;
  /** Enquiries whose owner changed. Zero unless the manager asked for it. */
  reassigned: number;
  /** How the day's work landed, by salesperson id. */
  perPerson: Record<string, number>;
}

/**
 * The maximum enquiries one press will deal out.
 *
 * Not a performance limit — a limit on how much of a branch's pipeline
 * one click can rearrange. A manager with four hundred pending
 * enquiries almost certainly means to work through them in batches, and
 * discovering that after the fact is not a recoverable mistake: the
 * previous owner of every lead is gone.
 */
// NOT exported: a "use server" module may export nothing but async
// functions, and a stray `export const` here is a build error rather
// than a type error — so it will not show up in `tsc --noEmit`.
const MAX_LEADS_PER_SPLIT = 200;

/**
 * Split the branch's pending enquiries across the salespeople on the
 * floor, and put a follow-up on each of their boards for the day.
 *
 * TWO THINGS HAPPEN AND THEY ARE NOT THE SAME THING.
 *
 *   1. A follow-up TASK is created for every enquiry dealt out. This is
 *      the part that is always safe: a task is new work, it takes
 *      nothing away from anyone, and uniq_task_from_lead means pressing
 *      the button twice does not double anybody's list.
 *
 *   2. The enquiry's OWNER is set. This is the part that is not safe,
 *      and it is why `include_assigned` exists and defaults to false.
 *      Off, only ownerless enquiries move — and they must, or the
 *      salesperson given the follow-up cannot open the lead at all
 *      (leads_select shows a sales exec only their own). On, every
 *      pending enquiry in the branch is re-dealt, which takes leads off
 *      people. That is a real thing a manager sometimes means, and it is
 *      never something they should do by accident.
 */
export async function distributeLeads(input: unknown): Promise<DistributeResult | ActionError> {
  const auth = await authorize([...MANAGER_ROLES]);
  if (!auth.ok) return auth.error;

  const parsed = await parseInput(DistributeLeadsSchema, input);
  if (!parsed.ok) return parsed.error;
  const { branch_id, due_on, include_assigned } = parsed.data;

  const denied = await assertBranch(auth.profile, branch_id);
  if (denied) return denied;

  const supabase = await createClient();

  // The floor, in name order. That order is the split — see splitLeads
  // in lib/tasks.ts on why it is stated rather than incidental.
  const { data: peopleRows } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("branch_id", branch_id)
    .eq("role", "sales_exec")
    .order("full_name");

  const floor = (peopleRows as Pick<Profile, "id" | "full_name">[] | null) ?? [];
  if (floor.length === 0) {
    return { error: "There are no sales executives at this branch to split the leads between." };
  }

  let query = supabase
    .from("leads")
    .select("id, client_name, salesperson_id")
    .eq("branch_id", branch_id)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_LEADS_PER_SPLIT);
  if (!include_assigned) query = query.is("salesperson_id", null);

  const { data: leadRows, error: leadError } = await query;
  if (leadError) return toUserError(leadError);

  const leads =
    (leadRows as { id: string; client_name: string; salesperson_id: string | null }[] | null) ?? [];
  if (leads.length === 0) {
    return { ok: true, created: 0, reassigned: 0, perPerson: {} };
  }

  const assignments = splitLeads(
    leads.map((l) => l.id),
    floor.map((p) => p.id)
  );
  const assigneeByLead = new Map(assignments.map((a) => [a.leadId, a.assigneeId]));
  const nameByLead = new Map(leads.map((l) => [l.id, l.client_name]));

  // (2) Ownership, and only where it actually changes. An enquiry that
  // is already this person's is left alone rather than rewritten, so the
  // audit trail carries the moves and nothing else.
  let reassigned = 0;
  for (const lead of leads) {
    const next = assigneeByLead.get(lead.id);
    if (!next || next === lead.salesperson_id) continue;
    const { error } = await supabase
      .from("leads")
      .update({ salesperson_id: next })
      .eq("id", lead.id);
    // Logged rather than aborted: a lead that refuses to move still gets
    // its follow-up, and stopping half way would leave the branch split
    // between two states with no way to tell which.
    if (error) console.error("[tasks] lead reassign failed", { lead: lead.id, error });
    else reassigned += 1;
  }

  // (1) The follow-ups. ignoreDuplicates rather than a merge: if a
  // follow-up for this enquiry already exists today it may well have
  // been ticked, and overwriting it would un-tick somebody's work.
  const { data: inserted, error: taskError } = await supabase
    .from("tasks")
    .upsert(
      assignments.map((a) => ({
        branch_id,
        assignee_id: a.assigneeId,
        title: `Follow up: ${nameByLead.get(a.leadId) ?? "enquiry"}`,
        due_on,
        origin: "lead" as const,
        lead_id: a.leadId,
        created_by: auth.profile.id,
      })),
      { onConflict: "lead_id,due_on", ignoreDuplicates: true }
    )
    .select("id, assignee_id");

  if (taskError) return toUserError(taskError);

  const created = (inserted as { id: string; assignee_id: string }[] | null) ?? [];
  const perPerson: Record<string, number> = {};
  for (const row of created) {
    perPerson[row.assignee_id] = (perPerson[row.assignee_id] ?? 0) + 1;
  }

  revalidatePath(TASKS_PATH, "page");
  revalidatePath("/[locale]/(app)/crm", "page");
  return { ok: true, created: created.length, reassigned, perPerson };
}

export interface EndDayResult {
  ok: true;
  done: number;
  skipped: number;
  ignored: number;
  total: number;
  /** Who the report reached. Empty is a real answer, not a failure. */
  recipients: string[];
  mailed: boolean;
}

/**
 * END DAY: count what happened, file it, and mail it up the line.
 *
 * THE DAY COMES FROM THE BROWSER, and that is not laziness. Workers run
 * in UTC; a showroom closing at 21:00 Cairo time would file three hours
 * of every evening under tomorrow. Every other window in FELIX — the
 * report suite, the attendance day — takes the viewer's offset for the
 * same reason.
 *
 * THE MAIL IS INTERNAL, ALWAYS. Recipients come from
 * day_report_recipients(), which returns FELIX addresses inside the
 * caller's own showroom and nothing else, so this never touches the
 * outbound Worker, never spends a Resend send, and cannot be aimed at an
 * address somebody typed. direction 'internal' and send_status null are
 * exactly what the compose action writes for a colleague-only message.
 *
 * NOBODY TO REPORT TO IS NOT A FAILURE. A one-person showroom, or a CEO
 * with no peer, gets the day_reports row and a message saying the
 * report was filed. Refusing to close the day because there was no
 * manager to tell would be a strange thing to do to somebody who has
 * just finished work.
 */
export async function endDay(input: unknown): Promise<EndDayResult | ActionError> {
  const auth = await authenticate();
  if (!auth.ok) return auth.error;
  const profile = auth.profile;
  if (!(TASK_ROLES as readonly string[]).includes(profile.role)) {
    return { error: "You do not have permission to perform this action." };
  }

  const parsed = await parseInput(EndDaySchema, input);
  if (!parsed.ok) return parsed.error;
  const { day, note } = parsed.data;

  const throttle = await consume(`end-day:${profile.id}`, LIMITS.endDay);
  if (!throttle.allowed) return { error: await retryMessage(throttle.retryAfter) };

  const supabase = await createClient();
  const t = await getTranslations("tasks");

  const { data: taskRows, error: taskError } = await supabase
    .from("tasks")
    .select("*")
    .eq("assignee_id", profile.id)
    .eq("due_on", day)
    .order("title");
  if (taskError) return toUserError(taskError);

  const tasks = (taskRows as TaskRow[] | null) ?? [];
  const counts = summariseDay(tasks);
  const buckets = bucketDay(tasks);

  const { data: recipientRows } = await supabase.rpc("day_report_recipients");
  // `error` swallowed on purpose: a deployment still on 0052 has no such
  // RPC, and the day should still close.
  const recipients = ((recipientRows as DayReportRecipient[] | null) ?? []).filter(
    (r) => r.mail_address
  );

  const subject = t("reportSubject", { name: profile.full_name, day });
  const lines: string[] = [
    t("reportHeading", { name: profile.full_name, day }),
    "",
    t("reportTally", {
      done: counts.done,
      skipped: counts.skipped,
      ignored: counts.open,
      total: counts.total,
      percent: completionPercent(counts),
    }),
  ];

  const section = (heading: string, rows: TaskRow[], withNote: boolean) => {
    if (rows.length === 0) return;
    lines.push("", heading);
    for (const row of rows) {
      const reason = withNote && row.completion_note ? ` — ${row.completion_note}` : "";
      lines.push(`• ${row.title}${reason}`);
    }
  };

  section(t("reportDone"), buckets.done, false);
  // The reason is carried only for the tasks that HAVE one. A declined
  // task with a note is a different thing from one left untouched, and
  // flattening the two would be the whole point of the report lost.
  section(t("reportSkipped"), buckets.skipped, true);
  section(t("reportIgnored"), buckets.ignored, false);

  if (counts.total === 0) lines.push("", t("reportNothingAsked"));
  if (note) lines.push("", t("reportNote"), note);

  const body = lines.join("\n");
  const bodyText = body + SIGNATURE_TEXT;
  const bodyHtml = textToHtml(body) + SIGNATURE_HTML;

  let mailMessageId: string | null = null;
  if (recipients.length > 0 && profile.mail_address) {
    const { data: message, error: mailError } = await supabase
      .from("mail_messages")
      .insert({
        sender_profile_id: profile.id,
        direction: "internal",
        from_address: profile.mail_address,
        from_name: profile.full_name,
        to_addresses: recipients.map((r) => r.mail_address).filter((a): a is string => !!a),
        cc_addresses: [],
        subject,
        body_text: bodyText,
        body_html: bodyHtml,
        snippet: snippetOf(body),
        thread_key: threadKeyOf(subject),
      })
      .select("id")
      .single();

    if (mailError) {
      console.error("[tasks] end-day mail insert failed", mailError);
    } else if (message) {
      mailMessageId = (message as { id: string }).id;
      const { error: fanoutError } = await supabase.from("mail_recipients").insert(
        recipients.map((r) => ({
          message_id: mailMessageId,
          profile_id: r.id,
          kind: "to" as const,
        }))
      );
      // Logged, not fatal — same call as the compose action makes. The
      // message is stored either way; a lost fan-out row hides it from
      // one inbox rather than losing it.
      if (fanoutError) {
        console.error("[tasks] end-day fan-out failed", { mailMessageId, fanoutError });
      }
    }
  }

  // The record, last, and upserted rather than inserted: finishing a
  // late task and pressing END DAY again must correct the day rather
  // than fail on uniq_day_report.
  const { error: reportError } = await supabase.from("day_reports").upsert(
    {
      profile_id: profile.id,
      branch_id: profile.branch_id,
      day,
      done_count: counts.done,
      skipped_count: counts.skipped,
      open_count: counts.open,
      total_count: counts.total,
      note,
      mail_message_id: mailMessageId,
      mail_status: mailMessageId ? "sent" : recipients.length > 0 ? "failed" : "skipped",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "profile_id,day" }
  );
  if (reportError) return toUserError(reportError);

  revalidatePath(TASKS_PATH, "page");
  return {
    ok: true,
    done: counts.done,
    skipped: counts.skipped,
    ignored: counts.open,
    total: counts.total,
    recipients: recipients.map((r) => r.full_name),
    mailed: mailMessageId !== null,
  };
}
