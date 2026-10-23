/**
 * The data a document needs in the staff app: the business's estimate templates, its letterhead
 * (name, address, phone, logo), and the signed-in person's saved signature. The builders that turn
 * records into a document live in build.ts and are re-exported here.
 */
import { pickTemplate, type TemplateSettings } from "@crewtavo/core/documents";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { documentCompany, signedTemplate, type TemplatedQuote } from "./build";
import type { DocumentCompany } from "./types";

export * from "./build";

/** A document_templates row. Its settings go through templateSettings() before they're used. */
export interface TemplateRow {
  id: string;
  name: string;
  is_default: boolean;
  settings: unknown;
}

export const templatesKey = (companyId: string) => ["document-templates", companyId] as const;

/** The business's estimate templates, the default first, then by name. */
export const templatesQuery = (companyId: string) =>
  queryOptions({
    queryKey: templatesKey(companyId),
    queryFn: async () => {
      const rows = unwrap(await supabase().from("document_templates").select("id, name, is_default, settings").eq("company_id", companyId).order("name")) as TemplateRow[];
      return [...rows].sort((a, b) => Number(b.is_default) - Number(a.is_default));
    },
  });

export function useTemplates() {
  const { company } = useSession();
  return useQuery(templatesQuery(company.id));
}

/** The template a quote prints with: the one it names, else the default, else the built-in look. */
export function useDocumentTemplate(templateId?: string | null): { template: TemplateSettings; isPending: boolean } {
  const templates = useTemplates();
  return { template: pickTemplate(templates.data ?? [], templateId), isPending: templates.isPending };
}

/**
 * The template a quote prints with, once it's signed too: a signed quote keeps the template saved
 * with its approval, whatever happened to the business's templates since. Before that (or for a
 * quote signed before approvals saved it), the same as useDocumentTemplate(quote.template_id).
 */
export function useQuoteTemplate(quote: TemplatedQuote): { template: TemplateSettings; isPending: boolean } {
  const live = useDocumentTemplate(quote.template_id);
  const signed = signedTemplate(quote);
  return signed ? { template: signed, isPending: false } : live;
}

export const letterheadKey = (companyId: string) => ["letterhead", companyId] as const;

/**
 * The business at the top of every document. It starts from the signed-in session (name, address,
 * logo, brand color), so a document shows straight away, then fills in the phone, email and website.
 */
export function useLetterhead() {
  const { company } = useSession();
  return useQuery({
    queryKey: letterheadKey(company.id),
    queryFn: async (): Promise<DocumentCompany> =>
      documentCompany(unwrap(await supabase().from("companies").select("name, phone, email, website, address, settings").eq("id", company.id).single())),
    placeholderData: () => documentCompany(company),
  });
}

export const mySignatureKey = (companyId: string, userId: string) => ["my-signature", companyId, userId] as const;

/** The signed-in person's saved signature (a PNG data URL), or null when they haven't saved one. */
export function useMySignature(options: { enabled?: boolean } = {}) {
  const { company, userId } = useSession();
  return useQuery({
    queryKey: mySignatureKey(company.id, userId),
    queryFn: async () => (await api.get<{ image: string | null }>("/me/signature")).image,
    enabled: options.enabled ?? true,
    staleTime: 5 * 60_000,
  });
}

/** Saves the signed-in person's signature for every estimate they sign after. */
export function useSaveMySignature() {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inline: true, success: "Signature saved" },
    mutationFn: async (image: string) => (await api.put<{ image: string }>("/me/signature", { image })).image,
    onSuccess: (image) => queryClient.setQueryData(mySignatureKey(company.id, userId), image),
  });
}

/** Forgets the signed-in person's saved signature. Estimates already signed keep theirs. */
export function useRemoveMySignature() {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { success: "Signature removed" },
    mutationFn: () => api.delete<{ ok: true }>("/me/signature"),
    onSuccess: () => queryClient.setQueryData(mySignatureKey(company.id, userId), null),
  });
}
