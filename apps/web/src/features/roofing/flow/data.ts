/**
 * The roofing project page's own records, beside the estimate the kit loads (useEstimateQuote): the
 * quote's dates, deposit, note to the client and package name, and its job; the team, to pick who
 * goes out; and whether the signed copy went to the homeowner. Everything here is under the
 * ["roofing-project", id] key, so the estimate kit's refreshEstimate loads it again too.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useSession } from "@/lib/session";
import { estimateKey, notesKey, refreshEstimateAfterEdits, type EstimateData } from "../estimate";
import { isSignedCopy, type TeamMember } from "./model";

export interface RoofProjectExtras {
  id: string;
  sent_at: string | null;
  valid_until: string | null;
  deposit_amount: number;
  message: string | null;
  created_at: string;
  promo: { code: string } | null;
  package: { name: string } | null;
  jobs: Array<{ id: string; number: number | null; status: string }>;
}

export const projectKey = (quoteId: string) => ["roofing-project", quoteId];

const EXTRA_FIELDS =
  "id, sent_at, valid_until, deposit_amount, message, created_at, promo:promo_codes(code), package:roof_packages!quotes_roof_package_fkey(name), jobs!jobs_company_id_quote_id_fkey(id, number, status)";

/** What the project page shows beyond the estimate itself. Loaded fresh each time the page opens. */
export function useRoofProject(quoteId: string) {
  return useQuery({
    queryKey: projectKey(quoteId),
    enabled: Boolean(quoteId),
    refetchOnMount: "always",
    queryFn: async () => {
      const row = unwrapOne(await supabase().from("quotes").select(EXTRA_FIELDS).eq("id", quoteId).maybeSingle(), "That roofing project") as unknown as RoofProjectExtras;
      return { ...row, deposit_amount: Number(row.deposit_amount ?? 0), jobs: row.jobs ?? [] };
    },
  });
}

/**
 * The estimate the kit keeps (["estimate", id]) loaded again when the page opens, so a roof measured
 * again on the map (which doesn't know this page) shows straight away. Not while edits are saving.
 */
export function useFreshEstimate(quoteId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const state = queryClient.getQueryState(estimateKey(quoteId));
    if (!state?.data || state.fetchStatus === "fetching" || queryClient.isMutating({ mutationKey: ["estimate-edit", quoteId] })) return;
    void queryClient.invalidateQueries({ queryKey: estimateKey(quoteId), exact: true });
  }, [queryClient, quoteId]);
}

/**
 * While the project waits on someone else (the homeowner's yes, the signature on site), look again
 * every so often, so the office sees it without reloading. Not while the tab is hidden or edits are
 * saving.
 */
export function useWatchProject(quoteId: string, waiting: boolean, everyMs = 45_000) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || queryClient.isMutating({ mutationKey: ["estimate-edit", quoteId] })) return;
      void queryClient.invalidateQueries({ queryKey: estimateKey(quoteId), exact: true });
      void queryClient.invalidateQueries({ queryKey: projectKey(quoteId) });
    }, everyMs);
    return () => window.clearInterval(timer);
  }, [queryClient, quoteId, waiting, everyMs]);
}

/** Loads the estimate and everything that shows it again (the estimate itself once − and + have saved). */
export function useRefreshProject(quoteId: string) {
  const queryClient = useQueryClient();
  const { company } = useSession();
  return () => void refreshEstimateAfterEdits(queryClient, quoteId, company.id);
}

/** The business's team (the same list Settings → Team and the schedule use). */
export function useTeam() {
  const { company } = useSession();
  return useQuery({ queryKey: ["team", company.id], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team") });
}

/** Who goes out on the site visit (quotes.salesperson_id). The pick shows at once. */
export function useSetSalesperson(quoteId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshProject(quoteId);
  return useMutation({
    meta: { success: (_: unknown, userId: string | null) => (userId ? "Site visit assigned" : "Nobody's assigned now") },
    onMutate: (userId: string | null) => {
      queryClient.setQueryData<EstimateData>(estimateKey(quoteId), (old) => (old ? { ...old, quote: { ...old.quote, salesperson_id: userId } } : old));
    },
    mutationFn: async (userId: string | null) => unwrap(await supabase().from("quotes").update({ salesperson_id: userId }).eq("id", quoteId)),
    onSettled: refresh,
  });
}

/**
 * The homeowner said yes to the range another way (on the phone, by text, in person), so the office
 * marks it (POST /roofing/:id/range-accepted). The range step moves on to booking the visit at once,
 * and the note saying who marked it shows with the others. A refusal (they'd already tapped Yes, or
 * the exact price went out) loads the project again too, so the page catches up.
 */
export function useMarkRangeAgreed(quoteId: string, clientFirstName: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshProject(quoteId);
  return useMutation({
    meta: { inline: true, success: `${clientFirstName} said yes to the range` },
    mutationFn: ({ note, optionId }: { note: string; optionId: string | null }) =>
      api.post<{ accepted_at: string; range: { low: number; high: number }; option_id: string | null }>(`/roofing/${quoteId}/range-accepted`, {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(optionId ? { option_id: optionId } : {}),
      }),
    onSuccess: (r) => {
      // A range told on the phone before it was sent is saved and counts as sent: the card moves on now.
      queryClient.setQueryData<EstimateData>(estimateKey(quoteId), (old) =>
        old
          ? {
              ...old,
              quote: {
                ...old.quote,
                status: old.quote.status === "draft" ? "sent" : old.quote.status,
                range_low: r.range.low,
                range_high: r.range.high,
                range_sent_at: old.quote.range_sent_at ?? r.accepted_at,
                range_accepted_at: r.accepted_at,
                option_id: r.option_id ?? old.quote.option_id,
              },
            }
          : old,
      );
      void queryClient.invalidateQueries({ queryKey: notesKey(quoteId) });
    },
    onSettled: refresh,
  });
}

/** The signed copies that went to the homeowner (emailed or texted), once it's signed. */
export function useSignedCopies(quoteId: string, signedAt: string | null) {
  return useQuery({
    queryKey: [...projectKey(quoteId), "copies"],
    enabled: Boolean(signedAt),
    meta: { silent: true },
    queryFn: async () => {
      const rows = unwrap(
        await supabase()
          .from("messages")
          .select("id, channel, subject, created_at")
          .eq("related_type", "quote")
          .eq("related_id", quoteId)
          .in("channel", ["email", "sms"])
          .order("created_at", { ascending: false })
          .limit(20),
      );
      // Copies sent from a minute before it was signed (the iPad sends one as it signs).
      const from = Date.parse(signedAt!) - 60_000;
      return rows.filter((m) => isSignedCopy(m) && Date.parse(m.created_at) >= from);
    },
  });
}

/** Emails or texts the homeowner their signed estimate. */
export function useSendSignedCopy(quoteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channel: "email" | "sms") => api.post<{ sent: boolean; reason?: string; link: string }>(`/quotes/${quoteId}/send-copy`, { channel }),
    onSuccess: (r, channel) => {
      if (r.sent) toast.success(channel === "email" ? "Copy emailed" : "Link texted");
      else toast.error(r.reason ?? "It didn't send. Try again in a minute.");
      void queryClient.invalidateQueries({ queryKey: [...projectKey(quoteId), "copies"] });
    },
  });
}

/**
 * Opens the homeowner's view in a new tab (a preview link, good for a day). The tab opens straight
 * away, on the tap, so the browser doesn't block it while the link is made.
 */
export function useOpenPreview(quoteId: string) {
  return useMutation({
    mutationFn: async (tab: Window | null) => {
      try {
        const { link } = await api.get<{ link: string }>(`/quotes/${quoteId}/link`);
        if (tab && !tab.closed) tab.location.href = link;
        else window.open(link, "_blank", "noopener");
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
  });
}

/** A blank tab opened on the tap, for a link that's still being made (useOpenPreview). */
export function blankTab(): Window | null {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  return tab;
}
