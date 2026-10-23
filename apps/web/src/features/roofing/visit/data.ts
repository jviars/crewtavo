/**
 * The site visit's data beyond the estimate itself (useEstimateQuote): who wrote the estimate and
 * the rest of what its document prints, the signed copies already sent, and the three steps that go
 * through the API: setting the price on site, signing, and sending the client a copy. Everything is
 * keyed under ["estimate", quoteId], so refreshEstimate reloads it with the estimate.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import { mySignatureKey } from "../../documents/data";
import { estimateKey, refreshEstimate } from "../estimate/data";
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

export interface VisitDetails {
  /** Who made the estimate in the office ("Nothing yet. Sarah's estimate is right as it is."). */
  author: VisitPerson | null;
  /** The roof package, for the strip under the address on the document. */
  packageName: string | null;
  /** The rest of what the document prints. */
  message: string | null;
  valid_until: string | null;
  deposit_amount: number;
  sent_at: string | null;
  created_at: string | null;
}

interface DetailsRow {
  created_by: string | null;
  message: string | null;
  valid_until: string | null;
  deposit_amount: number | string | null;
  sent_at: string | null;
  created_at: string | null;
  package: { name: string } | null;
}

export function useVisitDetails(quoteId: string) {
  return useQuery({
    queryKey: [...estimateKey(quoteId), "details"],
    queryFn: async (): Promise<VisitDetails> => {
      const row = unwrap(
        await supabase()
          .from("quotes")
          .select("created_by, message, valid_until, deposit_amount, sent_at, created_at, package:roof_packages!quotes_roof_package_fkey(name)")
          .eq("id", quoteId)
          .maybeSingle(),
      ) as unknown as DetailsRow | null;
      const profile = row?.created_by
        ? unwrap(await supabase().from("profiles").select("user_id, full_name, color, avatar_url").eq("user_id", row.created_by).maybeSingle())
        : null;
      return {
        author: profile?.full_name?.trim() ? { user_id: profile.user_id, name: profile.full_name.trim(), color: profile.color ?? null, photo: profile.avatar_url ?? null } : null,
        packageName: row?.package?.name ?? null,
        message: row?.message ?? null,
        valid_until: row?.valid_until ?? null,
        deposit_amount: Number(row?.deposit_amount ?? 0),
        sent_at: row?.sent_at ?? null,
        created_at: row?.created_at ?? null,
      };
    },
  });
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
