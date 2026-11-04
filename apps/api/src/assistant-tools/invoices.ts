/**
 * Invoices and payments: made from jobs by the database (create_invoice_for_job, which handles
 * deposits, progress billing and completed visits), sent and reminded through services/sales.ts,
 * and payments recorded the way the invoice screen records them. An assistant never refunds or
 * deletes a payment (the database refuses it too) and doesn't touch Stripe: card payments come in
 * through Stripe itself. Invoices are money: "Full access, no money" doesn't change them.
 */
import { entryHours, localDate, paymentProblem, workLines, zonedTimeToUtc } from "@crewtavo/core";
import { z } from "zod";
import { invoiceJobs, loggedWork as jobWork, remindInvoices, sendInvoice, sendSchema } from "../services/sales";
import { customFieldsArg, customFieldsPatch } from "./customFields";
import { changed, companyArg, friendly, one, rows, tool, type ToolContext } from "./tool";

const salesScope = (ctx: ToolContext) => ({ db: ctx.db, env: ctx.env, companyId: ctx.companyId, baseUrl: (ctx.env.APP_URL ?? ctx.origin).replace(/\/$/, "") });

/** A job's logged work waiting to be billed (services/sales.ts loggedWork), as the person's client reads it. */
const loggedWork = (ctx: ToolContext, jobId: string) => jobWork(ctx.db, ctx.companyId, jobId);

export const invoiceTools = {
  list_invoices: tool({
    description:
      "Invoices, newest first, with client, total, balance due and due date. Filter by status (draft, sent, partially_paid, paid, overdue, void, written_off, or unpaid: sent, partly paid and overdue) and client. Written off: the business took the loss on what's left, so it isn't counted as owed.",
    input: z.object({
      status: z.enum(["all", "unpaid", "draft", "sent", "partially_paid", "paid", "overdue", "void", "written_off"]).default("all"),
      client_id: z.uuid().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      let q = ctx.db.from("invoices").select("id, number, kind, status, total, balance_due, issued_on, due_on, client:clients(id, display_name)", { count: "exact" }).eq("company_id", ctx.companyId);
      if (a.status === "unpaid") q = q.in("status", ["sent", "partially_paid", "overdue"]);
      else if (a.status !== "all") q = q.eq("status", a.status);
      if (a.client_id) q = q.eq("client_id", a.client_id);
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(a.offset, a.offset + a.limit - 1);
      if (error) throw new Error(friendly(error.message));
      const next = a.offset + (data?.length ?? 0);
      return { total: count ?? data?.length ?? 0, invoices: data ?? [], next_offset: count !== null && next < count ? next : null };
    },
  }),
  get_invoice: tool({
    description:
      "An invoice in full: client, job, lines, totals, discounts and referral credits, tax, what's been paid (each payment), what's still owed, and its custom_fields (by key, list_custom_fields). A line's kind: minimum (the Minimum charge line, kept right while it's a draft, for minimum_charge) or late_fee (added once, late_fee_at).",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    run: (ctx, a) =>
      one(
        ctx.db
          .from("invoices")
          .select("id, number, kind, status, subtotal, discount_amount, credit_amount, credits:referral_credits(amount, note), tax_amount, total, amount_paid, balance_due, issued_on, due_on, written_off_at, minimum_charge, late_fee_at, custom_fields, job:jobs(id, number, title), client:clients(id, display_name, email, tax_exempt), lines:invoice_line_items(name, description, quantity, unit, unit_price, taxable, kind), payments(id, amount, tip_amount, method, received_at, notes, processor)")
          .eq("id", a.invoice_id)
          .eq("company_id", ctx.companyId)
          .maybeSingle(),
        "That invoice",
      ),
  }),
  invoice_job: tool({
    description:
      "Invoice a job: standard (the job's lines, less any deposit or progress already billed), visits (the completed visits not yet billed, for recurring and per-visit jobs), deposit or progress (an amount), or retainage. It's a draft until sent. It gets the job's and its quote's custom field values for the fields invoices have too, a Minimum charge line when it's under the company's minimum, and the client's own payment terms and tax exemption. Add the job's logged hours and materials to it with bill_logged_work.",
    input: z.object({ job_id: z.uuid(), kind: z.enum(["standard", "visits", "deposit", "progress", "retainage"]).default("standard"), amount: z.number().positive().max(1e8).optional(), ...customFieldsArg, ...companyArg }),
    area: "invoices",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db.rpc("create_invoice_for_job", { p_job: a.job_id, p_kind: a.kind, ...(a.amount ? { p_amount: a.amount } : {}) });
      if (error) throw new Error(friendly(error.message));
      const fields = await customFieldsPatch(ctx, "invoice", { id: data as string }, a.custom_fields);
      if (fields.custom_fields) await changed(ctx.db.from("invoices").update(fields).eq("id", data as string).eq("company_id", ctx.companyId).select("id"), "The invoice");
      return one(ctx.db.from("invoices").select("id, number, status, total, balance_due, custom_fields").eq("id", data as string).maybeSingle(), "The invoice");
    },
  }),
  logged_work: tool({
    description:
      "A job's logged hours (finished, approved or not; not breaks) and materials that no invoice bills yet, to put on its draft invoice with bill_logged_work. Materials are grouped by item and unit, each with a key; unit_price is null for one with no price list item, which needs a price. rates: the price list items sold by the hour that hours can be billed at, Labor first. What a worker is paid is never the price.",
    input: z.object({ job_id: z.uuid(), ...companyArg }),
    run: async (ctx, a) => {
      const work = await loggedWork(ctx, a.job_id);
      return {
        hours: work.hours.map((t) => ({ time_entry_id: t.id, user_id: t.user_id, started_at: t.started_at, hours: entryHours(t), approved: Boolean(t.approved_at) })),
        materials: work.materials.map(({ ids, ...m }) => ({ ...m, entries: ids.length })),
        rates: work.rates.map((r) => ({ service_id: r.id, name: r.name, unit: r.unit, unit_price: r.unit_price })),
      };
    },
  }),
  bill_logged_work: tool({
    description:
      "Put a job's logged hours and materials (logged_work) on its draft invoice (standard or completed visits; make it with invoice_job first). The hours go on as one line at rate_service_id's price (Labor unless given). time_entry_ids and material_keys default to everything logged_work offers that has a price; [] adds none. A material with no price list item goes on only with its price in material_prices, by key. Each is billed once: taking the line off or voiding the invoice frees it.",
    input: z.object({
      invoice_id: z.uuid(),
      time_entry_ids: z.array(z.uuid()).max(1000).optional(),
      rate_service_id: z.uuid().optional(),
      material_keys: z.array(z.string().max(300)).max(500).optional(),
      material_prices: z.record(z.string().max(300), z.number().min(0).max(10_000_000)).optional(),
      ...companyArg,
    }),
    area: "invoices",
    run: async (ctx, a) => {
      const invoice = await one(ctx.db.from("invoices").select("id, job_id, status, kind, lines:invoice_line_items(sort)").eq("id", a.invoice_id).eq("company_id", ctx.companyId).maybeSingle(), "That invoice");
      if (!invoice.job_id || invoice.status !== "draft" || !["standard", "visits"].includes(invoice.kind)) {
        throw new Error("Logged work goes on a draft invoice for a job's work (standard or completed visits).");
      }
      const work = await loggedWork(ctx, invoice.job_id);
      const hours = a.time_entry_ids ? work.hours.filter((t) => a.time_entry_ids!.includes(t.id)) : work.hours;
      if (a.time_entry_ids && hours.length < new Set(a.time_entry_ids).size) throw new Error("Some of those hours aren't waiting to be billed on this job (logged_work lists the ones that are).");
      const rate = a.rate_service_id ? work.rates.find((r) => r.id === a.rate_service_id) : work.rates[0];
      if (hours.length && !rate) {
        throw new Error(a.rate_service_id ? "That price list item isn't sold by the hour (unit hr)." : "The price list has no item sold by the hour, like Labor. Add one (add_services, unit hr) to bill hours.");
      }
      const priced = (m: (typeof work.materials)[number]) => m.unit_price !== null || a.material_prices?.[m.key] !== undefined;
      const materials = a.material_keys ? work.materials.filter((m) => a.material_keys!.includes(m.key)) : work.materials.filter(priced);
      const unpriced = materials.filter((m) => !priced(m));
      if (unpriced.length) throw new Error(`${unpriced.map((m) => `${m.name} (${m.key})`).join(", ")} has no price list item: give its price in material_prices.`);
      const lines = workLines({ hours, rate: rate ?? null, materials, prices: a.material_prices, timeZone: ctx.timezone });
      if (!lines.length) throw new Error("Nothing logged on this job is waiting to be billed.");
      const sort = Math.max(0, ...invoice.lines.map((l) => l.sort));
      await rows(ctx.db.from("invoice_line_items").insert(lines.map((l, i) => ({ ...l, company_id: ctx.companyId, invoice_id: invoice.id, sort: sort + i + 1 }))).select("id"));
      const left = work.materials.filter((m) => !materials.includes(m) && !priced(m));
      return {
        added: lines.length,
        ...(left.length && { still_to_price: left.map((m) => ({ key: m.key, name: m.name, quantity: m.quantity, unit: m.unit })) }),
        invoice: await one(ctx.db.from("invoices").select("id, number, subtotal, total, balance_due").eq("id", invoice.id).maybeSingle(), "The invoice"),
      };
    },
  }),
  update_invoice: tool({
    description: "Change an invoice's custom fields (list_custom_fields), by key. Its lines, dates and amounts are changed in Crewtavo.",
    input: z.object({ invoice_id: z.uuid(), custom_fields: customFieldsArg.custom_fields.unwrap(), ...companyArg }),
    area: "invoices",
    run: async (ctx, a) => {
      const fields = await customFieldsPatch(ctx, "invoice", { id: a.invoice_id }, a.custom_fields);
      if (fields.custom_fields) await changed(ctx.db.from("invoices").update(fields).eq("id", a.invoice_id).eq("company_id", ctx.companyId).select("id"), "That invoice");
      return { saved: true, custom_fields: fields.custom_fields ?? null };
    },
  }),
  invoice_jobs: tool({
    description:
      "Invoice many finished jobs at once (up to 50): one invoice each (completed visits for recurring and per-visit jobs), and email each one if send is true. Each job succeeds or fails on its own. Jobs charged automatically (autopay) are skipped while their charge waits.",
    input: z.object({ job_ids: z.array(z.uuid()).min(1).max(50), send: z.boolean().default(false), ...companyArg }),
    area: "invoices",
    run: (ctx, a) => invoiceJobs(salesScope(ctx), a.job_ids, a.send),
  }),
  send_invoice: tool({
    description: "Send an invoice to the client by email (default) or text, with their link to view and pay it; or just make the link (channel link). A draft becomes sent.",
    input: z.object({ invoice_id: z.uuid(), ...sendSchema.shape, ...companyArg }),
    area: "invoices",
    run: async (ctx, { invoice_id, company_id: _, ...body }) => sendInvoice(salesScope(ctx), invoice_id, body),
  }),
  send_reminders: tool({
    description: "Email a friendly payment reminder for these unpaid invoices (up to 100). Invoices with a bank payment on its way are skipped.",
    input: z.object({ invoice_ids: z.array(z.uuid()).min(1).max(100), ...companyArg }),
    area: "invoices",
    run: (ctx, a) => remindInvoices(salesScope(ctx), a.invoice_ids),
  }),
  record_payment: tool({
    description: "Record a payment the client made outside Crewtavo's online pay page: cash, check, ACH or other, up to the balance due, with an optional tip and a note (a check number). A draft invoice becomes sent. Card payments come in through Stripe. Card refunds are made from the invoice page (Refund) or in Stripe.",
    input: z.object({
      invoice_id: z.uuid(),
      amount: z.number().positive().max(1e8),
      method: z.enum(["cash", "check", "ach", "other"]),
      received_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Default today."),
      tip: z.number().min(0).max(1e6).optional(),
      notes: z.string().trim().max(500).optional(),
      ...companyArg,
    }),
    area: "invoices",
    run: async (ctx, a) => {
      const invoice = await one(ctx.db.from("invoices").select("id, client_id, status, balance_due, company:companies(currency)").eq("id", a.invoice_id).eq("company_id", ctx.companyId).maybeSingle(), "That invoice");
      if (invoice.status === "void") throw new Error("This invoice is void.");
      const problem = paymentProblem(a.amount, Number(invoice.balance_due), invoice.company?.currency);
      if (problem) throw new Error(problem);
      if (invoice.status === "draft") {
        const { error } = await ctx.db.from("invoices").update({ status: "sent" }).eq("id", invoice.id);
        if (error) throw new Error(friendly(error.message));
      }
      const day = a.received_on ?? localDate(new Date(), ctx.timezone);
      const payment = await one(
        ctx.db
          .from("payments")
          .insert({
            company_id: ctx.companyId,
            invoice_id: invoice.id,
            client_id: invoice.client_id,
            amount: Math.round(a.amount * 100) / 100,
            tip_amount: a.tip ? Math.round(a.tip * 100) / 100 : 0,
            method: a.method,
            received_at: zonedTimeToUtc(day, "12:00", ctx.timezone).toISOString(),
            notes: a.notes || null,
          })
          .select("id")
          .single(),
        "The payment",
      );
      const after = await one(ctx.db.from("invoices").select("status, balance_due").eq("id", invoice.id).maybeSingle(), "That invoice");
      return { payment_id: payment.id, invoice_status: after.status, balance_due: after.balance_due };
    },
  }),
  void_invoice: tool({
    description: "Void an invoice that hasn't been paid (one with payments can't be). It stays on record as void.",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    area: "invoices",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("invoices").update({ status: "void" }).eq("id", a.invoice_id).eq("company_id", ctx.companyId).select("id"), "That invoice");
      return { voided: true };
    },
  }),
  write_off_invoice: tool({
    description:
      "Write off what's still owed on a sent invoice the client is never going to pay (partly paid ones too): it stops counting as owed (receivables, past due, reminders) but still counts as invoiced, and keeps its visits. A payment that comes in later is still recorded on it. undo_write_off makes it owed again.",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    area: "invoices",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("invoices").update({ status: "written_off" }).eq("id", a.invoice_id).eq("company_id", ctx.companyId).select("id"), "That invoice");
      return one(ctx.db.from("invoices").select("id, number, status, balance_due, written_off_at").eq("id", a.invoice_id).maybeSingle(), "That invoice");
    },
  }),
  undo_write_off: tool({
    description: "Make a written-off invoice owed again: it's back with the unpaid invoices, past due if its due date has passed.",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    area: "invoices",
    run: async (ctx, a) => {
      await changed(ctx.db.from("invoices").update({ status: "sent" }).eq("id", a.invoice_id).eq("company_id", ctx.companyId).eq("status", "written_off").select("id"), "That written-off invoice");
      return one(ctx.db.from("invoices").select("id, number, status, balance_due").eq("id", a.invoice_id).maybeSingle(), "That invoice");
    },
  }),
};
