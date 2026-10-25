/**
 * A sub's My jobs from the server (routes/subOffers.ts): their offers and work at this company
 * (GET /api/sub/offers?all=1, public.my_sub_offers()), kept on the phone with My day, and answering
 * an offer. The sidebar and tab bar count the offers waiting from the same list.
 */
import type { SubOffer } from "@crewtavo/core/subOffers";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { isSub, type Session } from "@/lib/session";
import { myJobSections, type PayTotals } from "./myJobs";

/** Their offers and work here, waiting ones first (refreshed every minute, so a new offer shows). */
export const useMyJobs = (session: Pick<Session, "role" | "company">) =>
  useQuery({
    queryKey: ["field-jobs", session.company.id],
    enabled: isSub(session),
    refetchInterval: 60_000,
    meta: { silent: true },
    queryFn: () => api.get<SubOffer[]>("/sub/offers?all=1"),
  });

/** What they've been paid this year and are owed, counted by the server (kept on the phone with the list). */
export const useMyPayTotals = (session: Pick<Session, "role" | "company">) =>
  useQuery({
    queryKey: ["field-jobs", session.company.id, "totals"],
    enabled: isSub(session),
    refetchInterval: 60_000,
    meta: { silent: true },
    queryFn: () => api.get<PayTotals>("/sub/offers/totals"),
  });

/**
 * Which company a linked offer is from, when it isn't in the list here and they work for another
 * company too (null: not theirs to see, or not found).
 */
export const useOfferCompany = (payId: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ["field-jobs", "where", payId],
    enabled: Boolean(payId) && enabled,
    meta: { silent: true },
    queryFn: async () => {
      try {
        return (await api.get<{ company_id: string }>(`/sub/offers/${payId}/company`)).company_id;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });

/** How many offers are waiting for their answer. */
export const waitingCount = (offers: readonly SubOffer[] | undefined) => (offers ? myJobSections(offers).waiting.length : 0);

/** Take it (accept) or turn it down; `round` is the offer they were looking at. */
export const answerOffer = (id: string, body: { accept: boolean; reason?: string | null; round: number }) =>
  api.post<{ offer: SubOffer | null }>(`/sub/offers/${id}/answer`, body);
