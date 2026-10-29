/**
 * Kinds of notification a person can also get by email, text or a push to their phone (the bell in
 * the app always shows everything). Mirrors the check on public.notification_prefs.
 */
export const NOTIFICATION_TOPICS = [
  { key: "schedule", label: "My schedule changes", hint: "Added to or taken off a visit, moved or cancelled" },
  { key: "client", label: "Messages from clients", hint: "Texts and Client Hub messages" },
  { key: "time", label: "Clock reminders", hint: "When a clock has been running too long" },
  { key: "equipment", label: "Equipment maintenance", hint: "Service coming due or overdue" },
  // People with the subs area only (packages/core/src/roles.ts).
  { key: "subs", label: "Subcontractors", hint: "Insurance running out, paperwork a sub sends in, and answers to job offers" },
  // Subs only: their job offers and their pay (on by default, texts too: an offer waits for their answer).
  { key: "jobs", label: "My jobs", hint: "Job offers, and what you're owed and paid" },
  { key: "alerts", label: "Other alerts", hint: "From your company's automations, like a quote being approved" },
  { key: "chat", label: "Team chat", hint: "When someone @mentions you or your role" },
  // Owners and admins: Railway's warnings (services/hosting.ts) and storage nearing its limit
  // (services/storageUsage.ts). Off Railway, Settings → Profile calls it "Storage".
  { key: "hosting", label: "Railway", hint: "Before the trial runs out, or when the bill goes over the plan or storage fills up" },
] as const;
export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]["key"];

export const NOTIFICATION_CHANNELS = ["email", "sms", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Defaults until a person changes them (same as the column defaults). */
export const DEFAULT_NOTIFICATION_PREFS: Record<NotificationChannel, NotificationTopic[]> = {
  email: ["schedule", "jobs", "hosting"],
  sms: ["jobs"],
  push: ["schedule", "client", "equipment", "subs", "jobs", "time", "alerts", "chat", "hosting"],
};

/**
 * notifications.kind -> topic. Automations use the subject's type (quote, invoice...) as the kind.
 */
export function notificationTopic(kind: string): NotificationTopic {
  if (kind === "schedule" || kind === "client" || kind === "equipment" || kind === "time" || kind === "chat" || kind === "hosting" || kind === "subs" || kind === "jobs") return kind;
  return "alerts";
}
