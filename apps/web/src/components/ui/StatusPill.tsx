const TONES = {
  good: { bg: "var(--green-tint)", fg: "var(--green-dark)", dot: "var(--job)" },
  info: { bg: "var(--invoice-tint)", fg: "var(--invoice-text)", dot: "var(--invoice)" },
  warning: { bg: "var(--warning-tint)", fg: "var(--warning)", dot: "var(--req)" },
  danger: { bg: "var(--danger-tint)", fg: "var(--danger)", dot: "var(--danger)" },
  muted: { bg: "var(--fill-2)", fg: "var(--text-2)", dot: "#9aa39d" },
} as const;

export type Tone = keyof typeof TONES;

/** Status is always shown as text in a pill, never color alone. */
export function StatusPill({ label, tone = "muted" }: { label: string; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <span className="pill" style={{ background: t.bg, color: t.fg }}>
      <span className="pill-dot" style={{ background: t.dot }} />
      {label}
    </span>
  );
}

const VISIT_TONES: Record<string, Tone> = {
  completed: "good",
  in_progress: "info",
  en_route: "info",
  scheduled: "muted",
  unscheduled: "warning",
  cancelled: "danger",
};

/** "in_progress" -> "In progress" */
export const statusLabel = (status: string) => (status.charAt(0).toUpperCase() + status.slice(1)).replace(/_/g, " ");

export const visitTone = (status: string): Tone => VISIT_TONES[status] ?? "muted";

const ENTITY_TONES: Record<string, Record<string, Tone>> = {
  client: { lead: "warning", active: "good", archived: "muted" },
  request: { new: "warning", assessment_scheduled: "info", assessment_complete: "info", quoted: "good", converted: "good", archived: "muted" },
  quote: { draft: "muted", sent: "info", changes_requested: "warning", approved: "good", converted: "good", lost: "danger", archived: "muted" },
  job: { active: "info", requires_invoicing: "warning", completed: "good", archived: "muted" },
  invoice: { draft: "muted", sent: "info", partially_paid: "warning", paid: "good", overdue: "danger", void: "muted" },
};

const LABELS: Record<string, string> = {
  sent: "Awaiting response",
  changes_requested: "Changes requested",
  requires_invoicing: "Requires invoicing",
  partially_paid: "Partly paid",
  assessment_complete: "Assessment done",
  assessment_scheduled: "Assessment booked",
};

/** Pill for a record's status, e.g. <EntityStatus kind="quote" status="sent" />. */
export function EntityStatus({ kind, status }: { kind: keyof typeof ENTITY_TONES; status: string }) {
  const label = kind === "invoice" && status === "sent" ? "Awaiting payment" : LABELS[status] ?? statusLabel(status);
  return <StatusPill label={label} tone={ENTITY_TONES[kind]?.[status] ?? "muted"} />;
}
