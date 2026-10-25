/**
 * The site visit's data beyond the estimate itself (useEstimateQuote): who wrote the estimate and
 * the rest of what its document prints (with the options it offers and the contract's own facts),
 * the signed copies already sent, and the three steps that go through the API: setting the price on
 * site, signing (and loading the paper again when the server says it changed), and sending the
 * client a copy. Everything is keyed under ["estimate", quoteId], so refreshEstimate reloads it with
 * the estimate.
 */
import type { TemplateSettings } from "@crewtavo/core/documents";
import { chosenTotals, type Amount } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import { NO_CONTRACT, type OptionOffer, type QuoteContract } from "../../documents/build";
import { mySignatureKey, templatesKey, type QuoteContractInput } from "../../documents/data";
import { estimateKey, refreshEstimate } from "../estimate/data";
import type { EstimateLine, EstimateQuote } from "../estimate/types";
import { readSigningOutcome, signedCopies, type SigningOutcome } from "./price";

/** Statuses that mean the estimate is signed (the lines are locked). */
export const SIGNED_STATUSES = ["approved", "converted"];
export const isSignedQuote = (quote: { status: string }) => SIGNED_STATUSES.includes(quote.status);

/** People who price and sell work: owners, admins, the office and estimators, with the sales area. */
export function useCanSell(): boolean {
  const session = useSession();
  return hasRole(session, "admin", "office", "estimator") && can(session, "sales");
}

export const visitPath = (quoteId: string, page: "visit" | "sign" | "signed") => `/roofing/${quoteId}/${page}`;

// ---------------------------------------------------------------------------------------------
// What the document and the headings need
// ---------------------------------------------------------------------------------------------

export interface VisitPerson {
  user_id: string;
  name: string;
  color: string | null;
  photo: string | null;
}

/** An option the estimate offers (quote_options), as the paper and the contract read it. */
export interface VisitOption extends OptionOffer {
  warranty: string;
  /** The contract sections its package brings. */
  section_ids: string[];
  sort: number;
}

export interface VisitDetails {
  /** Who made the estimate in the office ("Nothing yet. Sarah's estimate is right as it is."). */
  author: VisitPerson | null;
  /** The roof package, for the strip under the address on the document. */
  packageName: string | null;
  /** Its warranty, which {Warranty} says on an estimate without options (as the server fills it in). */
  packageWarranty: string | null;
  /** The rest of what the document prints. */
  message: string | null;
  valid_until: string | null;
  deposit_amount: number;
  sent_at: string | null;
  created_at: string | null;
  /** The option shown (quotes.option_id): the one the homeowner chose on the visit page, and signs for. Null without options. */
  optionId: string | null;
  /** The options it offers, in order; none without options. */
  options: VisitOption[];
  /** Which option each line is on (null: on every option), by line id. */
  lineOptions: Record<string, string | null>;
  /** The contract sections added to this job (quotes.section_ids). */
  sectionIds: string[];
  /** The client's billing address, which the contract's {Customer address} fills in with. */
  billingAddress: unknown;
  /** The promo code on it, which its totals are worked out with. */
  promo: { kind: string; value: number } | null;
}

interface DetailsRow {
  created_by: string | null;
  message: string | null;
  valid_until: string | null;
  deposit_amount: number | string | null;
  sent_at: string | null;
  created_at: string | null;
  option_id: string | null;
  section_ids: string[] | null;
  package: { name: string; warranty: string | null } | null;
  promo: { kind: string; value: number } | null;
  client: { billing_address: unknown } | null;
  options: VisitOption[] | null;
  lines: Array<{ id: string; option_id: string | null }> | null;
}

export function useVisitDetails(quoteId: string) {
  return useQuery({
    queryKey: [...estimateKey(quoteId), "details"],
    queryFn: async (): Promise<VisitDetails> => {
      const row = unwrap(
        await supabase()
          .from("quotes")
          .select(
            "created_by, message, valid_until, deposit_amount, sent_at, created_at, option_id, section_ids, package:roof_packages!quotes_roof_package_fkey(name, warranty), promo:promo_codes(kind, value), client:clients(billing_address), options:quote_options!quote_options_quote_fkey(id, name, tier, picture, picture_width, picture_height, style, highlights, warranty, section_ids, sort), lines:quote_line_items(id, option_id)",
          )
          .eq("id", quoteId)
          .maybeSingle(),
      ) as unknown as DetailsRow | null;
      const profile = row?.created_by
        ? unwrap(await supabase().from("profiles").select("user_id, full_name, color, avatar_url").eq("user_id", row.created_by).maybeSingle())
        : null;
      return {
        author: profile?.full_name?.trim() ? { user_id: profile.user_id, name: profile.full_name.trim(), color: profile.color ?? null, photo: profile.avatar_url ?? null } : null,
        packageName: row?.package?.name ?? null,
        packageWarranty: row?.package?.warranty ?? null,
        message: row?.message ?? null,
        valid_until: row?.valid_until ?? null,
        deposit_amount: Number(row?.deposit_amount ?? 0),
        sent_at: row?.sent_at ?? null,
        created_at: row?.created_at ?? null,
        optionId: row?.option_id ?? null,
        options: [...(row?.options ?? [])].sort((a, b) => a.sort - b.sort),
        lineOptions: Object.fromEntries((row?.lines ?? []).map((l) => [l.id, l.option_id])),
        sectionIds: row?.section_ids ?? [],
        billingAddress: row?.client?.billing_address ?? null,
        promo: row?.promo ?? null,
      };
    },
  });
}

/** The estimate's lines with the option each is on (from the details, unless the line says itself). */
export function linesWithOptions<L extends Pick<EstimateLine, "id">>(lines: readonly L[], lineOptions: Record<string, string | null> | undefined): Array<L & { option_id: string | null }> {
  return lines.map((l) => {
    const own = (l as { option_id?: string | null }).option_id;
    return { ...l, option_id: own !== undefined ? own : (lineOptions?.[l.id] ?? null) };
  });
}

/**
 * What the homeowner signs for on the iPad, as the paper shows it: with options, what the option shown
 * comes to with the add-ons left on, worked out as the database does (core chosenTotals); without
 * options, the quote's own amounts. Its total goes with the signature (expected_total), so a quote
 * that changed since isn't signed.
 */
export function signingTotals(
  quote: { subtotal: Amount; discount_amount: Amount; tax_amount: Amount; total: Amount; tax_rate: Amount },
  lines: ReadonlyArray<{ id: string; option_id: string | null; quantity: Amount; unit_price: Amount; taxable?: boolean | null; optional?: boolean | null; selected?: boolean | null }>,
  optionId: string | null,
  promo: { kind: string; value: Amount } | null,
): { subtotal: number; discount: number; tax: number; total: number } {
  if (!optionId) return { subtotal: Number(quote.subtotal), discount: Number(quote.discount_amount), tax: Number(quote.tax_amount), total: Number(quote.total) };
  const picked = lines.filter((l) => l.optional && l.selected && (l.option_id === null || l.option_id === optionId)).map((l) => l.id);
  return chosenTotals(lines, optionId, optionId, picked, { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo });
}

/**
 * What the contract on the iPad's paper is filled in from (documents/data.ts useQuoteContract): the
 * estimate, the visit's details, the template it's signed on, the option chosen with the tier word
 * its card shows (`tier`, core optionTierLabels as the server words it) and the total on the paper.
 * Without options, {Option} and {Warranty} say the package it was priced from. The server fills in
 * the copy it keeps from the same facts and fingerprints the same card (services/signing.ts, core
 * contractInput and sectionsHash), so the words signed are the words kept. Null until the details
 * are in.
 */
export function signContractInput(
  quote: Pick<EstimateQuote, "status" | "number" | "approval" | "client" | "property">,
  details: Pick<VisitDetails, "sent_at" | "created_at" | "deposit_amount" | "sectionIds" | "billingAddress" | "options" | "packageName" | "packageWarranty"> | null | undefined,
  template: TemplateSettings,
  option: Pick<VisitOption, "name" | "warranty" | "section_ids" | "highlights" | "tier"> | null,
  total: Amount,
  tier: string | null = null,
): QuoteContractInput | null {
  if (!details) return null;
  return {
    quote: { status: quote.status, number: quote.number, sent_at: details.sent_at, created_at: details.created_at ?? "", deposit_amount: details.deposit_amount, section_ids: details.sectionIds, approval: quote.approval },
    template,
    option: option ? { name: option.name, warranty: option.warranty, section_ids: option.section_ids, tier: tier ?? option.tier ?? null, highlights: option.highlights ?? [] } : null,
    fill: !details.options.length && details.packageName !== null ? { name: details.packageName, warranty: details.packageWarranty ?? "" } : null,
    total,
    client: { display_name: quote.client?.display_name ?? null, billing_address: details.billingAddress },
    property: quote.property,
  };
}


/**
 * The contract the paper being signed prints: the one loaded (with the initials added so far), or
 * when it didn't load (`failed`), none, rather than the template's own terms with their fill-ins
 * unfilled ("I, {Customer name}, agree…"). Only ever what the paper shows: signing still waits for
 * the contract itself. Null while it's loading.
 */
export const paperContract = (contract: QuoteContract | null, failed: boolean): QuoteContract | null => contract ?? (failed ? NO_CONTRACT : null);

/**
 * Everything the paper being signed is built from, loaded again after the server said the option,
 * the price or the terms changed since (a 409): the estimate and its details (refreshEstimate), the
 * templates (the terms and the sections a template picks: the office may have changed them while
 * the homeowner was reading), the library's sections and the business's own facts. Done once
 * they're all in, so the next try is signed on the paper as it is now, not the old one again.
 */
export async function checkSigningAgain(queryClient: QueryClient, quoteId: string, companyId: string): Promise<void> {
  refreshEstimate(queryClient, quoteId, companyId);
  await Promise.all([
    queryClient.refetchQueries({ queryKey: estimateKey(quoteId), type: "active" }, { cancelRefetch: false }),
    ...[templatesKey(companyId), ["contract-sections", companyId], ["contract-company", companyId]].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ]);
}

/** The signed copies emailed or texted since the estimate was signed. */
export function useSignedCopies(quoteId: string, approvedAt: string | null) {
  return useQuery({
    queryKey: [...estimateKey(quoteId), "copies", approvedAt],
    queryFn: async () =>
      signedCopies(
        unwrap(
          await supabase()
            .from("messages")
            .select("channel, subject, created_at")
            .eq("related_type", "quote")
            .eq("related_id", quoteId)
            .eq("direction", "out")
            .in("channel", ["email", "sms"])
            .order("created_at", { ascending: false })
            .limit(20),
        ),
        approvedAt,
      ),
  });
}

// ---------------------------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------------------------

/**
 * The price agreed on site (before tax), or null for the estimate as it is. The estimate is loaded
 * again before this finishes, so the next screen shows the price that was saved.
 */
export function useSetSitePrice(quoteId: string) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["site-price", quoteId],
    meta: { inline: true },
    mutationFn: (price: number | null) => api.put<{ subtotal: number; discount_amount: number; tax_amount: number; total: number }>(`/roofing/${quoteId}/site-price`, { price }),
    onSuccess: async () => {
      refreshEstimate(queryClient, quoteId, company.id);
      await queryClient.refetchQueries({ queryKey: estimateKey(quoteId), exact: true }, { cancelRefetch: false });
    },
    // Whatever went wrong (it was signed meanwhile, say), show the estimate as it is now.
    onError: () => refreshEstimate(queryClient, quoteId, company.id),
  });
}

export interface SignBody {
  name: string;
  signature: string;
  company_signature?: string;
  save_signature?: boolean;
  email_copy?: boolean;
  /** The option they chose (the one shown), when it offers options. */
  option_id?: string;
  /** The total on the paper: it's only signed while the quote still comes to it. */
  expected_total?: number;
  /** The fingerprint of the terms on the paper (build.ts QuoteContract hash). */
  sections_hash?: string;
  /** Their initials, for the sections that ask (a small PNG data URL). */
  initials?: string;
}

export interface SignResult {
  status: "approved";
  emailed: boolean;
  email_reason?: string;
  link: string;
}

export const signingKey = (quoteId: string) => ["sign-estimate", quoteId];

const outcomeKey = (quoteId: string) => `crewtavo.signed.${quoteId}`;

/** What the signed screen was told (router state), else what this tab kept when it was signed. */
export function signingOutcome(quoteId: string, state: unknown): SigningOutcome | null {
  const fromState = readSigningOutcome(state);
  if (fromState) return fromState;
  try {
    const kept = sessionStorage.getItem(outcomeKey(quoteId));
    return kept ? readSigningOutcome(JSON.parse(kept)) : null;
  } catch {
    return null;
  }
}

/** The homeowner signs on the iPad (POST /quotes/:id/sign): the estimate is approved with both signatures. */
export function useSignEstimate(quoteId: string) {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: signingKey(quoteId),
    meta: { inline: true },
    mutationFn: (body: SignBody) => api.post<SignResult>(`/quotes/${quoteId}/sign`, body),
    onSuccess: async (result, body) => {
      try {
        sessionStorage.setItem(outcomeKey(quoteId), JSON.stringify({ emailed: result.emailed, email_reason: result.email_reason ?? null } satisfies SigningOutcome));
      } catch {
        // Private browsing: the signed screen still finds an emailed copy in the messages.
      }
      if (body.save_signature && body.company_signature) queryClient.setQueryData(mySignatureKey(company.id, userId), body.company_signature);
      refreshEstimate(queryClient, quoteId, company.id);
      // The signed screen reads the estimate from here: wait until it says signed.
      await queryClient.refetchQueries({ queryKey: estimateKey(quoteId), exact: true }, { cancelRefetch: false });
    },
  });
}

/** Emails or texts the client their signed estimate (POST /quotes/:id/send-copy). */
export function useSendCopy(quoteId: string, channel: "email" | "sms") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["signed-copy", quoteId, channel],
    meta: { inline: true },
    mutationFn: () => api.post<{ sent: boolean; reason?: string; link: string }>(`/quotes/${quoteId}/send-copy`, { channel }),
    onSuccess: (result) => {
      if (result.sent) void queryClient.invalidateQueries({ queryKey: [...estimateKey(quoteId), "copies"] });
    },
  });
}
