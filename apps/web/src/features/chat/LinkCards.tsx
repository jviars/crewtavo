/**
 * Cards under a message for its first links (three at most, never one inside code, core
 * cardLinks): a web page as its site, title, two lines of what it's about and a small picture (GET
 * /api/chat/preview, which reads it from the public internet and shrinks the picture, so nobody's
 * browser loads anything from the site); and a link to one of this Crewtavo's own records (a quote,
 * an invoice, a job, a client or a request, or a Client Hub link to one) as what it is, with its
 * number, client, status and amount. Records are read with the viewer's own access, so someone who
 * can't open one sees just that: "A quote you can't open".
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { cardLinks, type ChatRecordKind, type ChatRecordLink } from "@crewtavo/core/chatContent";
import { Icon, type IconName } from "@/components/ui/Icon";
import { StatusPill, statusText } from "@/components/ui/StatusPill";
import { api, supabase } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { msg, t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { ChatMessage } from "./data";
import l from "./linkCards.module.css";

interface Preview {
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  image: string | null;
}

interface RecordRow {
  id: string;
  number?: number | null;
  title?: string | null;
  subject?: string | null;
  display_name?: string;
  company_name?: string | null;
  status: string;
  total?: number | null;
  balance_due?: number | null;
  client?: { display_name: string } | null;
}

const RECORDS: Record<ChatRecordKind, { table: string; columns: string; icon: IconName; path: string; label: string; unseen: string }> = {
  quote: { table: "quotes", columns: "id, number, title, status, total, client:clients(display_name)", icon: "quote", path: "/quotes/", label: msg("Quote #{number}"), unseen: msg("A quote you can't open") },
  invoice: { table: "invoices", columns: "id, number, subject, status, total, balance_due, client:clients(display_name)", icon: "invoice", path: "/invoices/", label: msg("Invoice #{number}"), unseen: msg("An invoice you can't open") },
  job: { table: "jobs", columns: "id, number, title, status, client:clients(display_name)", icon: "job", path: "/jobs/", label: msg("Job #{number}"), unseen: msg("A job you can't open") },
  client: { table: "clients", columns: "id, display_name, company_name, status", icon: "clients", path: "/clients/", label: msg("Client"), unseen: msg("A client you can't open") },
  request: { table: "requests", columns: "id, number, title, status, client:clients(display_name)", icon: "requests", path: "/requests/", label: msg("Request #{number}"), unseen: msg("A request you can't open") },
};

/** This Crewtavo's records the links name, by kind, as the viewer can read them (a row the viewer can't read isn't there). */
function useRecords(links: ChatRecordLink[]) {
  const { company } = useSession();
  const byKind = useMemo(() => {
    const map = new Map<ChatRecordKind, string[]>();
    for (const link of links) map.set(link.kind, [...new Set([...(map.get(link.kind) ?? []), link.id])].sort());
    return [...map];
  }, [links]);
  const queries = useQueries({
    queries: byKind.map(([kind, ids]) => ({
      queryKey: ["chat-records", company.id, kind, ids],
      staleTime: 2 * 60_000,
      retry: false,
      meta: { silent: true },
      queryFn: async () => {
        const { data, error } = await supabase().from(RECORDS[kind].table as "quotes").select(RECORDS[kind].columns).eq("company_id", company.id).in("id", ids);
        // A role that can't read the kind at all reads as none of them.
        if (error) return [] as RecordRow[];
        return (data ?? []) as unknown as RecordRow[];
      },
    })),
  });
  return (kind: ChatRecordKind, id: string): RecordRow | null | undefined => {
    const at = byKind.findIndex(([k]) => k === kind);
    const query = queries[at];
    if (!query?.data) return query?.isPending ? undefined : null;
    return query.data.find((row) => row.id === id) ?? null;
  };
}

function RecordCard({ link, row }: { link: ChatRecordLink; row: RecordRow | null | undefined }) {
  const record = RECORDS[link.kind];
  if (row === undefined) return <span className={`${l.card} ${l.record}`} aria-busy="true"><span className={l.recordIcon}><Icon name={record.icon} size={18} /></span><span className={l.text}><span className={l.quiet}>{t("Loading…")}</span></span></span>;
  if (row === null) {
    return (
      <span className={`${l.card} ${l.record}`}>
        <span className={l.recordIcon}><Icon name="lock" size={16} /></span>
        <span className={l.text}><span className={l.quiet}>{t(record.unseen)}</span></span>
      </span>
    );
  }
  const name = link.kind === "client" ? row.display_name : row.title || row.subject || null;
  const heading = link.kind === "client" ? row.display_name : [row.number ? t(record.label, { number: row.number }) : null, name].filter(Boolean).join(" · ");
  const client = link.kind === "client" ? row.company_name : row.client?.display_name;
  const amount =
    link.kind === "invoice" && row.balance_due && row.balance_due > 0 && row.status !== "draft" ? t("{amount} due", { amount: formatMoney(row.balance_due) })
    : typeof row.total === "number" ? formatMoney(row.total)
    : null;
  return (
    <Link className={`${l.card} ${l.record}`} to={`${record.path}${row.id}`}>
      <span className={l.recordIcon} data-kind={link.kind}><Icon name={record.icon} size={18} /></span>
      <span className={l.text}>
        <span className={l.title}>{heading}</span>
        <span className={l.meta}>
          {[client, amount, link.hub ? t("Client Hub link") : null].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className={l.status}><StatusPill label={statusText(link.kind, row.status)} /></span>
    </Link>
  );
}

function PreviewCard({ message, href }: { message: ChatMessage; href: string }) {
  const { company } = useSession();
  const preview = useQuery({
    queryKey: ["chat", company.id, "preview", href],
    queryFn: () => api.get<{ preview: Preview | null }>(`/chat/preview?message=${message.id}&url=${encodeURIComponent(href)}`).then((r) => r.preview),
    staleTime: 60 * 60_000,
    gcTime: 2 * 60 * 60_000,
    retry: false,
    meta: { silent: true },
  });
  const p = preview.data;
  if (!p) return null;
  return (
    <a className={`${l.card} ${l.page}`} href={href} target="_blank" rel="noreferrer noopener">
      <span className={l.text}>
        {p.site_name && <span className={l.site}>{p.site_name}</span>}
        {p.title && <span className={l.title}>{p.title}</span>}
        {p.description && <span className={l.description}>{p.description}</span>}
      </span>
      {p.image && <img className={l.image} src={p.image} alt="" loading="lazy" />}
    </a>
  );
}

export function LinkCards({ message }: { message: ChatMessage }) {
  const { company } = useSession();
  const links = useMemo(() => cardLinks(message.body, window.location.origin, company.id), [message.body, company.id]);
  const records = useMemo(() => links.flatMap((x) => (x.record ? [x.record] : [])), [links]);
  const recordOf = useRecords(records);
  if (!links.length) return null;
  return (
    <div className={l.cards}>
      {links.map((x) => (x.record ? <RecordCard key={x.href} link={x.record} row={recordOf(x.record.kind, x.record.id)} /> : <PreviewCard key={x.href} message={message} href={x.href} />))}
    </div>
  );
}
