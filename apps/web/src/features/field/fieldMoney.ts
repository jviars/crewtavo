/**
 * Who finishes the paperwork on site, and how much of the money they see. The team adds work from
 * the price list without seeing a price; making the invoice, its total, sending it and recording
 * cash or check are for owners, admins and office with the invoices area, as on the job page. The
 * database decides the same (20261106000700_field_lines.sql, and the invoices and payments rules).
 */
import { can, hasRole, type Session } from "@/lib/session";

type Who = Pick<Session, "role" | "permissions">;

/** Adds work to a visit's job from the price list: the team, never a sub (the prices are the client's). */
export const addsWork = (who: Who) => who.role !== "subcontractor";

/** A job that takes work added on site (add_field_line): a one-off still open. A repeating job's lines bill every visit. */
export const takesWork = (job: { kind: string; status: string }) => job.kind !== "recurring" && (job.status === "active" || job.status === "requires_invoicing");

/** Makes the job's invoice on site, sees its total, sends it and records cash or check. */
export const takesMoney = (who: Who) => hasRole(who, "admin", "office") && can(who, "invoices");

/**
 * The invoice a visit's Create invoice makes: what the job page's Create invoice offers first. A
 * one-off job's final invoice, or a per-visit job's finished visits. Null for a fixed price, which
 * the office bills by the month.
 */
export function fieldInvoiceKind(job: { kind: string; pricing: string | null }): "standard" | "visits" | null {
  if (job.kind !== "recurring") return "standard";
  return job.pricing === "fixed" ? null : "visits";
}
