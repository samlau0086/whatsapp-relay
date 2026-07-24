import type { PoolClient } from "pg";
import { pool, transaction } from "./db.js";
import { dispatchPending } from "./agent-hub.js";
import { generatePersonalizedTaskMessage } from "./agent-engine.js";
import { queueWhatsAppCommand } from "./whatsapp-outbound.js";

export const TASK_TOOLS = [
  "knowledge_search",
  "contact_profile_read",
  "conversation_memory_read",
  "recent_messages_read",
  "order_summary_read",
  "create_task",
  "generate_draft",
  "queue_message",
] as const;
export type TaskTool = (typeof TASK_TOOLS)[number];
const COMPLETE = new Set(["completed", "cancelled", "failed"]);
type HolidayDefinition = {
  id: string;
  name: string;
  month: number;
  day: number;
};
function holidayDefinitions(value: unknown): HolidayDefinition[] {
  return Array.isArray(value)
    ? value.filter((item): item is HolidayDefinition =>
        Boolean(
          item &&
            typeof item === "object" &&
            typeof (item as HolidayDefinition).id === "string" &&
            typeof (item as HolidayDefinition).name === "string" &&
            Number.isInteger(Number((item as HolidayDefinition).month)) &&
            Number.isInteger(Number((item as HolidayDefinition).day)),
        ),
      )
    : [];
}
let lastRuleScan = 0;

export function effectiveTaskTools(
  defaultTools: unknown,
  overrideTools: unknown,
): TaskTool[] {
  const source = Array.isArray(overrideTools)
    ? overrideTools
    : Array.isArray(defaultTools)
      ? defaultTools
      : [];
  return [
    ...new Set(
      source
        .map(String)
        .filter((tool): tool is TaskTool =>
          (TASK_TOOLS as readonly string[]).includes(tool),
        ),
    ),
  ];
}
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
export function observedDate(
  year: number,
  month: number,
  day: number,
  policy: string,
): { month: number; day: number } | null {
  if (month !== 2 || day !== 29 || isLeapYear(year)) return { month, day };
  if (policy === "mar1") return { month: 3, day: 1 };
  if (policy === "leap_year_only") return null;
  return { month: 2, day: 28 };
}
export function nextRecurringDate(
  from: Date,
  recurrence: unknown,
): Date | null {
  if (!recurrence || typeof recurrence !== "object") return null;
  const value = recurrence as {
      kind?: string;
      interval?: number;
      daysOfWeek?: number[];
      until?: string | null;
    },
    interval = Math.max(1, Number(value.interval) || 1),
    next = new Date(from);
  if (value.kind === "daily") next.setUTCDate(next.getUTCDate() + interval);
  else if (value.kind === "weekly") {
    const days = [...new Set(value.daysOfWeek ?? [])].sort((a, b) => a - b);
    for (let offset = 1; offset <= 7 * interval; offset++) {
      const candidate = new Date(from);
      candidate.setUTCDate(candidate.getUTCDate() + offset);
      if (days.includes(candidate.getUTCDay())) {
        next.setTime(candidate.getTime());
        break;
      }
    }
  } else if (value.kind === "monthly")
    next.setUTCMonth(next.getUTCMonth() + interval);
  else if (value.kind === "yearly")
    next.setUTCFullYear(next.getUTCFullYear() + interval);
  else return null;
  if (value.until && next > new Date(value.until)) return null;
  return next;
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date),
    get = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}
function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let value = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const parts = localParts(new Date(value), timeZone),
      target = Date.UTC(year, month - 1, day, hour, minute),
      actual = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
      );
    value += target - actual;
  }
  return new Date(value);
}
function daysBetween(
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
) {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) -
      Date.UTC(a.year, a.month - 1, a.day)) /
      86400000,
  );
}

export async function processOneTaskCycle(): Promise<boolean> {
  if (Date.now() - lastRuleScan > 60_000) {
    lastRuleScan = Date.now();
    await ensureContactRulesAndTasks();
    await markOverdueTasks();
  }
  const draftId = await transaction(async (client) => {
    const draft = await client.query(
      `SELECT t.id FROM tasks t JOIN account_task_settings s ON s.account_id=t.account_id WHERE t.kind='message' AND t.status='planned' AND t.send_at IS NOT NULL AND t.send_at-(s.draft_lead_hours||' hours')::interval<=now() AND NOT EXISTS(SELECT 1 FROM task_drafts d WHERE d.task_id=t.id AND d.status IN ('pending','approved','sent')) ORDER BY t.send_at LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
    );
    if (!draft.rowCount) return null;
    await client.query(
      "UPDATE tasks SET status='in_progress',updated_at=now() WHERE id=$1",
      [draft.rows[0].id],
    );
    return String(draft.rows[0].id);
  });
  if (draftId) {
    try {
      await generateTaskDraft(draftId);
    } catch (error) {
      console.error("Task draft generation failed", {
        taskId: draftId,
        error: String(error),
      });
    }
    return true;
  }
  const readyId = await transaction(async (client) => {
    const ready = await client.query(
      `SELECT t.id FROM tasks t WHERE t.kind='message' AND t.status='scheduled' AND t.send_at<=now() AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.depends_on_task_id WHERE d.task_id=t.id AND p.status<>'completed') ORDER BY t.send_at LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
    );
    if (!ready.rowCount) return null;
    await client.query(
      "UPDATE tasks SET status='in_progress',updated_at=now() WHERE id=$1",
      [ready.rows[0].id],
    );
    return String(ready.rows[0].id);
  });
  if (readyId) {
    try {
      await dispatchTask(readyId);
    } catch (error) {
      const detail = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 1000);
      await pool.query(
        "UPDATE tasks SET status='failed',last_error=$2,updated_at=now() WHERE id=$1",
        [readyId, detail],
      );
      console.error("Scheduled task dispatch failed", {
        taskId: readyId,
        error: detail,
      });
    }
    return true;
  }
  return false;
}

async function ensureContactRulesAndTasks(): Promise<void> {
  await pool.query(
    "INSERT INTO account_task_settings(account_id) SELECT id FROM whatsapp_accounts ON CONFLICT(account_id) DO NOTHING",
  );
  const rows = await pool.query(
    `SELECT co.id contact_id,co.account_id,co.birthday_month,co.birthday_day,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) contact_name,a.display_name account_name,COALESCE(ts.timezone,'UTC') timezone,COALESCE(ts.default_lead_days,14) default_lead_days,COALESCE(ts.default_send_mode,'approval') default_send_mode,COALESCE(ts.leap_day_policy,'feb28') leap_day_policy FROM contacts co JOIN whatsapp_accounts a ON a.id=co.account_id LEFT JOIN account_task_settings ts ON ts.account_id=co.account_id WHERE co.birthday_month IS NOT NULL AND co.birthday_day IS NOT NULL`,
  );
  for (const row of rows.rows)
    await ensureAnnualContactTask(
      row,
      "birthday",
      "birthday",
      Number(row.birthday_month),
      Number(row.birthday_day),
      `为 ${row.contact_name} 准备生日祝福`,
    );
  const specials = await pool.query(
    `SELECT d.id special_id,d.contact_id,d.kind,d.label,d.month,d.day,d.lead_days,co.account_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) contact_name,COALESCE(ts.timezone,'UTC') timezone,COALESCE(ts.default_lead_days,14) default_lead_days,COALESCE(ts.default_send_mode,'approval') default_send_mode,COALESCE(ts.leap_day_policy,'feb28') leap_day_policy FROM contact_special_dates d JOIN contacts co ON co.id=d.contact_id LEFT JOIN account_task_settings ts ON ts.account_id=co.account_id`,
  );
  for (const row of specials.rows)
    await ensureAnnualContactTask(
      row,
      "special_date",
      String(row.special_id),
      Number(row.month),
      Number(row.day),
      `为 ${row.contact_name} 准备${row.label}消息`,
      row.lead_days == null ? undefined : Number(row.lead_days),
    );
  const holidayContacts = await pool.query(
    `SELECT co.id contact_id,co.account_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) contact_name,ts.timezone,ts.holiday_definitions,ts.default_lead_days,ts.default_send_mode,ts.leap_day_policy FROM contacts co JOIN account_task_settings ts ON ts.account_id=co.account_id`,
  );
  for (const row of holidayContacts.rows)
    for (const holiday of holidayDefinitions(row.holiday_definitions))
      await ensureAnnualContactTask(
        row,
        "holiday",
        holiday.id,
        holiday.month,
        holiday.day,
        `为 ${row.contact_name} 准备${holiday.name}问候`,
      );
  const holidayRules = await pool.query(
    `SELECT r.*,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) contact_name,COALESCE(ts.timezone,'UTC') timezone,ts.holiday_definitions,COALESCE(ts.default_lead_days,14) default_lead_days,COALESCE(ts.leap_day_policy,'feb28') leap_day_policy FROM task_rules r JOIN contacts co ON co.id=r.contact_id JOIN account_task_settings ts ON ts.account_id=r.account_id WHERE r.enabled AND r.source='holiday' AND r.source_key=ANY(ts.enabled_holidays)`,
  );
  for (const row of holidayRules.rows) {
    const holiday = holidayDefinitions(row.holiday_definitions).find(
      (item) => item.id === String(row.source_key),
    );
    if (holiday)
      await ensureTaskOccurrence(
        row,
        holiday.month,
        holiday.day,
        String(row.title_template || `${holiday.name} · ${row.contact_name}`),
      );
  }
}

export async function arrangeAccountHolidayTasks(
  accountId: string,
): Promise<{
  contactCount: number;
  holidayCount: number;
  ruleCount: number;
  taskCount: number;
}> {
  const [settings, result] = await Promise.all([
    pool.query(
      "SELECT timezone,holiday_definitions,enabled_holidays,default_lead_days,default_send_mode,leap_day_policy FROM account_task_settings WHERE account_id=$1",
      [accountId],
    ),
    pool.query(
      `SELECT id contact_id,account_id,COALESCE(NULLIF(alias,''),display_name,phone_e164) contact_name
       FROM contacts WHERE account_id=$1`,
      [accountId],
    ),
  ]);
  const accountSettings = settings.rows[0] ?? {};
  const enabledHolidays = new Set<string>(
    Array.isArray(accountSettings.enabled_holidays)
      ? accountSettings.enabled_holidays.map(String)
      : [],
  );
  const holidays = holidayDefinitions(
    accountSettings.holiday_definitions,
  ).filter((holiday) => enabledHolidays.has(holiday.id));
  let taskCount = 0;
  for (const row of result.rows) {
    for (const holiday of holidays) {
      if (
        await ensureAnnualContactTask(
          { ...row, ...accountSettings },
          "holiday",
          holiday.id,
          holiday.month,
          holiday.day,
          `为 ${row.contact_name} 准备${holiday.name}问候`,
        )
      )
        taskCount++;
    }
  }
  return {
    contactCount: result.rowCount ?? 0,
    holidayCount: holidays.length,
    ruleCount: (result.rowCount ?? 0) * holidays.length,
    taskCount,
  };
}

async function ensureAnnualContactTask(
  row: Record<string, unknown>,
  source: string,
  key: string,
  month: number,
  day: number,
  title: string,
  leadDays?: number,
) {
  const rule = await pool.query(
    `INSERT INTO task_rules(account_id,contact_id,source,source_key,title_template,month,day,lead_days,send_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,contact_id,source,source_key) DO UPDATE SET title_template=EXCLUDED.title_template,month=EXCLUDED.month,day=EXCLUDED.day,lead_days=EXCLUDED.lead_days,enabled=true,updated_at=now() RETURNING *`,
    [
      row.account_id,
      row.contact_id,
      source,
      key,
      title,
      month,
      day,
      leadDays ?? row.default_lead_days,
      row.default_send_mode,
    ],
  );
  return ensureTaskOccurrence({ ...row, ...rule.rows[0] }, month, day, title);
}

async function ensureTaskOccurrence(
  row: Record<string, unknown>,
  month: number,
  day: number,
  title: string,
): Promise<boolean> {
  const timezone = String(row.timezone ?? "UTC"),
    today = localParts(new Date(), timezone),
    lead = Number(row.lead_days ?? row.default_lead_days ?? 14);
  let year = today.year,
    observed = observedDate(
      year,
      month,
      day,
      String(row.leap_day_policy ?? "feb28"),
    );
  if (
    !observed ||
    daysBetween(today, { year, month: observed.month, day: observed.day }) < 0
  ) {
    year++;
    observed = observedDate(
      year,
      month,
      day,
      String(row.leap_day_policy ?? "feb28"),
    );
  }
  if (!observed) return false;
  const distance = daysBetween(today, {
    year,
    month: observed.month,
    day: observed.day,
  });
  if (distance < 0 || distance > lead) return false;
  const sendAt = zonedDate(year, observed.month, observed.day, 9, 0, timezone),
    startAt = new Date(sendAt.getTime() - lead * 86400000),
    dueAt = sendAt;
  const result = await pool.query(
    `INSERT INTO tasks(account_id,contact_id,rule_id,kind,source,source_key,occurrence_date,title,description,status,start_at,due_at,send_at,send_mode,tool_overrides) VALUES($1,$2,$3,'message',$4,$5,$6,$7,$8,'planned',$9,$10,$10,$11,$12) ON CONFLICT(rule_id,contact_id,occurrence_date) WHERE rule_id IS NOT NULL AND occurrence_date IS NOT NULL DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,start_at=EXCLUDED.start_at,due_at=EXCLUDED.due_at,send_at=EXCLUDED.send_at,send_mode=EXCLUDED.send_mode,updated_at=now() WHERE tasks.status='planned'`,
    [
      row.account_id,
      row.contact_id,
      row.id,
      row.source,
      row.source_key,
      `${year}-${String(observed.month).padStart(2, "0")}-${String(observed.day).padStart(2, "0")}`,
      title,
      String(row.description ?? ""),
      startAt,
      dueAt,
      row.send_mode ?? "approval",
      row.tool_overrides ?? null,
    ],
  );
  return Boolean(result.rowCount);
}

export async function markOverdueTasks(): Promise<void> {
  await pool.query(
    `UPDATE tasks SET status='overdue',last_error=CASE WHEN kind='message' AND status='waiting_approval' THEN 'approval_deadline_missed' WHEN kind='message' AND status='scheduled' THEN 'task_dependency_incomplete' ELSE last_error END,updated_at=now() WHERE (status IN ('planned','in_progress','waiting_approval') OR (status='scheduled' AND EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.depends_on_task_id WHERE d.task_id=tasks.id AND p.status<>'completed'))) AND (CASE WHEN kind='message' THEN send_at ELSE due_at END)<now()`,
  );
}

async function logTool(
  runId: string,
  tool: string,
  allowed: boolean,
  metadata: unknown = {},
) {
  await pool.query(
    "INSERT INTO task_tool_audit(run_id,tool,allowed,metadata) VALUES($1,$2,$3,$4)",
    [runId, tool, allowed, JSON.stringify(metadata)],
  );
  if (!allowed) throw new Error(`task_tool_forbidden:${tool}`);
}

export async function generateTaskDraft(taskId: string): Promise<void> {
  const found = await pool.query(
    `SELECT t.*,COALESCE(s.persona,'You are a helpful, concise relationship assistant.') persona,COALESCE(s.reply_language,'auto') reply_language,COALESCE(ts.default_tools,'{}') default_tools,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) contact_name,co.phone_e164,co.note,co.birthday_month,co.birthday_day,co.birthday_year,c.id resolved_conversation_id,COALESCE(mem.summary,'') memory_summary FROM tasks t JOIN contacts co ON co.id=t.contact_id LEFT JOIN conversations c ON c.account_id=t.account_id AND c.contact_id=t.contact_id LEFT JOIN conversation_memories mem ON mem.conversation_id=c.id LEFT JOIN account_agent_settings s ON s.account_id=t.account_id LEFT JOIN account_task_settings ts ON ts.account_id=t.account_id WHERE t.id=$1`,
    [taskId],
  );
  if (!found.rowCount) return;
  const task = found.rows[0];
  if (COMPLETE.has(String(task.status))) return;
  const tools = effectiveTaskTools(task.default_tools, task.tool_overrides),
    run = await pool.query(
      "INSERT INTO task_agent_runs(task_id,kind,tools_used) VALUES($1,'draft',$2) RETURNING id",
      [taskId, tools],
    ),
    runId = String(run.rows[0].id);
  try {
    await logTool(runId, "generate_draft", tools.includes("generate_draft"));
    const conversationId = task.resolved_conversation_id
      ? String(task.resolved_conversation_id)
      : null;
    const contact = tools.includes("contact_profile_read")
      ? {
          name: task.contact_name,
          phone: task.phone_e164,
          note: task.note,
          birthday: {
            month: task.birthday_month,
            day: task.birthday_day,
            year: task.birthday_year,
          },
        }
      : {};
    if (tools.includes("contact_profile_read"))
      await logTool(runId, "contact_profile_read", true);
    const [notes, tags, memory, facts, messages, orders] = conversationId
      ? await Promise.all([
          tools.includes("contact_profile_read")
            ? pool.query(
                "SELECT body FROM notes WHERE conversation_id=$1 ORDER BY updated_at DESC LIMIT 20",
                [conversationId],
              )
            : Promise.resolve({ rows: [] }),
          tools.includes("contact_profile_read")
            ? pool.query(
                "SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY t.name",
                [conversationId],
              )
            : Promise.resolve({ rows: [] }),
          Promise.resolve({
            rows: tools.includes("conversation_memory_read")
              ? [{ summary: task.memory_summary }]
              : [],
          }),
          tools.includes("conversation_memory_read")
            ? pool.query(
                "SELECT fact_key,fact_value,confidence FROM customer_memory_facts WHERE conversation_id=$1 ORDER BY updated_at DESC LIMIT 30",
                [conversationId],
              )
            : Promise.resolve({ rows: [] }),
          tools.includes("recent_messages_read")
            ? pool.query(
                "SELECT direction,kind,text_content,occurred_at FROM messages WHERE conversation_id=$1 ORDER BY occurred_at DESC LIMIT 20",
                [conversationId],
              )
            : Promise.resolve({ rows: [] }),
          tools.includes("order_summary_read")
            ? pool.query(
                "SELECT display_order_number,status,amount,currency,description,created_at FROM orders WHERE conversation_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10",
                [conversationId],
              )
            : Promise.resolve({ rows: [] }),
        ])
      : Array.from({ length: 6 }, () => ({ rows: [] }));
    for (const tool of [
      "conversation_memory_read",
      "recent_messages_read",
      "order_summary_read",
    ] as TaskTool[])
      if (tools.includes(tool)) await logTool(runId, tool, true);
    const persona = String(task.persona_override || task.persona),
      result = await generatePersonalizedTaskMessage({
        accountId: String(task.account_id),
        persona,
        language: String(task.reply_language),
        occasion: String(task.title),
        taskDescription: String(task.description ?? ""),
        contact,
        notes: notes.rows,
        tags: tags.rows,
        memory: memory.rows[0] ?? {},
        facts: facts.rows,
        messages: messages.rows.reverse(),
        orders: orders.rows,
        knowledgeQuery: [task.title, task.description, task.memory_summary]
          .filter(Boolean)
          .join("\n"),
        allowKnowledge: tools.includes("knowledge_search"),
      });
    if (tools.includes("knowledge_search"))
      await logTool(runId, "knowledge_search", true);
    await transaction(async (client) => {
      await client.query(
        "UPDATE task_drafts SET status='rejected',resolved_at=now() WHERE task_id=$1 AND status='pending'",
        [taskId],
      );
      await client.query(
        "INSERT INTO task_drafts(task_id,text_content,reply_zh,citations,context_snapshot) VALUES($1,$2,$3,$4,$5)",
        [
          taskId,
          result.reply,
          result.replyZh,
          JSON.stringify(result.citations),
          JSON.stringify(result.contextSnapshot),
        ],
      );
      await client.query(
        "UPDATE tasks SET conversation_id=COALESCE(conversation_id,$2),status=CASE WHEN send_mode='auto' AND $3::boolean THEN 'scheduled' ELSE 'waiting_approval' END,last_error=NULL,updated_at=now() WHERE id=$1",
        [taskId, conversationId, tools.includes("queue_message")],
      );
      await client.query(
        "UPDATE task_agent_runs SET status='completed',citations=$2,context_snapshot=$3,response_text=$4,completed_at=now() WHERE id=$1",
        [
          runId,
          JSON.stringify(result.citations),
          JSON.stringify(result.contextSnapshot),
          result.reply,
        ],
      );
    });
  } catch (error) {
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 1000);
    await pool.query(
      "UPDATE task_agent_runs SET status='failed',error=$2,completed_at=now() WHERE id=$1",
      [runId, detail],
    );
    await pool.query(
      "UPDATE tasks SET status='failed',last_error=$2,updated_at=now() WHERE id=$1",
      [taskId, detail],
    );
    throw error;
  }
}

async function ensureConversation(
  client: PoolClient,
  task: Record<string, unknown>,
) {
  const existing = await client.query(
    "SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2",
    [task.account_id, task.contact_id],
  );
  if (existing.rowCount) return String(existing.rows[0].id);
  const created = await client.query(
    "INSERT INTO conversations(account_id,contact_id,status,assigned_user_id) VALUES($1,$2,'open',$3) RETURNING id",
    [task.account_id, task.contact_id, task.assigned_user_id],
  );
  return String(created.rows[0].id);
}

export async function dispatchTask(
  taskId: string,
  actorId?: string,
): Promise<{ messageId: string; agentId: string | null } | null> {
  const result = await transaction(async (client) => {
    const found = await client.query(
      `SELECT t.*,a.agent_id,co.wa_jid,COALESCE(ts.default_tools,'{}') default_tools FROM tasks t JOIN whatsapp_accounts a ON a.id=t.account_id JOIN contacts co ON co.id=t.contact_id LEFT JOIN account_task_settings ts ON ts.account_id=t.account_id WHERE t.id=$1 FOR UPDATE OF t`,
      [taskId],
    );
    if (!found.rowCount) return null;
    const task = found.rows[0],
      tools = effectiveTaskTools(task.default_tools, task.tool_overrides),
      workerClaim = actorId === undefined && task.status === "in_progress";
    if (task.status !== "scheduled" && !workerClaim)
      throw new Error("task_not_scheduled");
    if (task.send_mode === "auto" && !tools.includes("queue_message"))
      throw new Error("task_queue_message_forbidden");
    const blocked = await client.query(
      "SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.depends_on_task_id WHERE d.task_id=$1 AND p.status<>'completed' LIMIT 1",
      [taskId],
    );
    if (blocked.rowCount) throw new Error("task_dependency_incomplete");
    const draft = await client.query(
      "SELECT id,text_content FROM task_drafts WHERE task_id=$1 AND status IN ('approved','pending') ORDER BY generated_at DESC LIMIT 1",
      [taskId],
    );
    if (!draft.rowCount) throw new Error("task_draft_missing");
    if (task.send_mode === "approval" && draft.rows[0].id && !task.approved_at)
      throw new Error("task_not_approved");
    const conversationId = await ensureConversation(client, task),
      clientMessageId = `task-${taskId}`,
      existing = await client.query(
        "SELECT id FROM messages WHERE account_id=$1 AND client_message_id=$2",
        [task.account_id, clientMessageId],
      );
    if (existing.rowCount)
      return {
        messageId: String(existing.rows[0].id),
        agentId: task.agent_id ? String(task.agent_id) : null,
      };
    const message = await client.query(
      "INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) RETURNING id",
      [
        conversationId,
        task.account_id,
        actorId ?? task.approved_by ?? null,
        clientMessageId,
        draft.rows[0].text_content,
      ],
    );
    const queued = await queueWhatsAppCommand(client, {
      accountId: task.account_id,
      conversationId,
      messageId: message.rows[0].id,
      payload: {
          accountId: task.account_id,
          conversationId,
          clientMessageId,
          type: "text",
          text: draft.rows[0].text_content,
          messageId: message.rows[0].id,
          toJid: task.wa_jid,
      },
    });
    await client.query(
      "UPDATE task_drafts SET status='sent',resolved_at=COALESCE(resolved_at,now()),resolved_by=COALESCE(resolved_by,$2) WHERE id=$1",
      [draft.rows[0].id, actorId ?? task.approved_by ?? null],
    );
    await client.query(
      "UPDATE tasks SET conversation_id=$2,status='completed',progress=100,completed_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",
      [taskId, conversationId],
    );
    await scheduleNextOccurrence(client, task);
    return {
      messageId: String(message.rows[0].id),
      agentId: queued.agentId,
    };
  });
  if (result?.agentId) void dispatchPending(result.agentId);
  return result;
}

async function scheduleNextOccurrence(
  client: PoolClient,
  task: Record<string, unknown>,
) {
  if (!task.recurrence) return;
  const nextStart = nextRecurringDate(
      new Date(String(task.start_at)),
      task.recurrence,
    ),
    nextDue = nextRecurringDate(new Date(String(task.due_at)), task.recurrence),
    nextSend = task.send_at
      ? nextRecurringDate(new Date(String(task.send_at)), task.recurrence)
      : null;
  if (!nextStart || !nextDue) return;
  await client.query(
    `INSERT INTO tasks(account_id,contact_id,conversation_id,assigned_user_id,created_by,parent_task_id,kind,source,title,description,status,progress,start_at,due_at,send_at,send_mode,recurrence,persona_override,tool_overrides) VALUES($1,$2,$3,$4,$5,$6,$7,'recurring',$8,$9,'planned',0,$10,$11,$12,$13,$14,$15,$16)`,
    [
      task.account_id,
      task.contact_id,
      task.conversation_id,
      task.assigned_user_id,
      task.created_by,
      task.id,
      task.kind,
      task.title,
      task.description,
      nextStart,
      nextDue,
      nextSend,
      task.send_mode,
      task.recurrence,
      task.persona_override,
      task.tool_overrides,
    ],
  );
}

export async function completeGeneralTask(taskId: string, actorId: string) {
  await transaction(async (client) => {
    const blocked = await client.query(
      "SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.depends_on_task_id WHERE d.task_id=$1 AND p.status<>'completed' LIMIT 1",
      [taskId],
    );
    if (blocked.rowCount) throw new Error("task_dependency_incomplete");
    const task = await client.query(
      "UPDATE tasks SET status='completed',progress=100,completed_at=now(),updated_at=now() WHERE id=$1 AND kind='general' AND status NOT IN ('completed','cancelled') RETURNING *",
      [taskId],
    );
    if (task.rowCount) await scheduleNextOccurrence(client, task.rows[0]);
    await client.query(
      "INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'task.complete','task',$2,'{}')",
      [actorId, taskId],
    );
  });
}
