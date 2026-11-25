/**
 * A client's name that, on a computer, shows a small card when it's hovered or tabbed to: who they
 * are, how to reach them, where they are and (for those who see money) what they owe, with a way to
 * open them. What's on it is read only once it opens. On a touch screen the name is just its link.
 *
 *   <ClientPreview id={job.client.id}>
 *     <Link to={`/clients/${job.client.id}`}>{job.client.display_name}</Link>
 *   </ClientPreview>
 *
 * The card is extra, never the only way to something: everything on it is on the client's page.
 */
import { PreviewCard } from "@base-ui/react/preview-card";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { nextWhen, useClientVisits } from "@/lib/clientVisits";
import { addressLine, formatMoney } from "@/lib/format";
import { t } from "@/lib/i18n";
import { can, hasRole, useSession } from "@/lib/session";
import { Icon } from "./Icon";
import { layerFor } from "./layer";
import { Skeleton } from "./Skeleton";
import styles from "./ClientPreview.module.css";

/** A mouse or trackpad that can hover: phones and tablets get the plain link. */
const canHover = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** The card sits over a list row or a page that reacts to clicks and presses: what happens on it stays on it. */
const keep = (e: SyntheticEvent) => e.stopPropagation();

export function ClientPreview({ id, children }: { id: string; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLAnchorElement>(null);
  if (!canHover()) return children;
  return (
    <PreviewCard.Root open={open} onOpenChange={setOpen}>
      <PreviewCard.Trigger ref={trigger} render={children} delay={500} closeDelay={150} />
      {/* Inside an open dialog it has to open inside it, or it would sit behind it. Otherwise the
          page: Base UI takes a null container as "not yet" and wouldn't open at all. */}
      <PreviewCard.Portal container={layerFor(trigger.current) ?? undefined}>
        <PreviewCard.Positioner className={styles.positioner} side="bottom" align="start" sideOffset={6} collisionPadding={12}>
          <PreviewCard.Popup className={styles.card} onClick={keep} onPointerDown={keep} onContextMenu={keep}>
            <Card id={id} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/**
 * A client's name in a list: a quiet link to their page, with the card on a computer. In a row that
 * opens something else (a job, a quote), a click on the name stays on the name.
 */
export function ClientLink({ id, name }: { id: string; name: string }) {
  return (
    <ClientPreview id={id}>
      <Link className={styles.link} to={`/clients/${id}`} onClick={keep}>{name}</Link>
    </ClientPreview>
  );
}

function Card({ id }: { id: string }) {
  const session = useSession();
  const seesMoney = hasRole(session, "admin", "office") && can(session, "invoices");
  const client = useQuery({
    queryKey: ["client-preview", id, seesMoney],
    staleTime: 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const [found, invoices] = await Promise.all([
        supabase().from("clients").select("id, display_name, company_name, email, phone, properties(line1, city, region, postal_code)").eq("id", id).maybeSingle(),
        // What they owe, as on their page: what's left on invoices sent and not yet paid.
        seesMoney ? supabase().from("invoices").select("balance_due, status").eq("client_id", id).in("status", ["sent", "partially_paid", "overdue"]) : null,
      ]);
      const unpaid = invoices ? unwrap(invoices) : null;
      return {
        ...unwrapOne(found),
        owed: unpaid ? unpaid.reduce((sum, i) => sum + Number(i.balance_due), 0) : null,
        late: Boolean(unpaid?.some((i) => i.status === "overdue" && Number(i.balance_due) > 0)),
      };
    },
  });

  const next = useClientVisits(id).data?.next;

  if (client.isPending) {
    return (
      <div className={styles.head} aria-hidden="true">
        <Skeleton width="60%" height={14} />
        <Skeleton width="80%" />
        <Skeleton width="50%" />
      </div>
    );
  }
  if (client.isError) return <span className="muted">{t("Couldn't load this")}</span>;
  const c = client.data;
  const address = addressLine(c.properties[0]);
  return (
    <>
      <div className={styles.head}>
        <span className={styles.name}>{c.display_name}</span>
        {c.company_name && c.company_name !== c.display_name && <span className={styles.company}>{c.company_name}</span>}
      </div>
      {(c.phone || c.email || address || next) && (
        <ul className={styles.lines}>
          {c.phone && <li className={styles.line}><Icon name="phone" size={14} />{c.phone}</li>}
          {c.email && <li className={styles.line}><Icon name="mail" size={14} />{c.email}</li>}
          {address && <li className={styles.line}><Icon name="pin" size={14} />{address}</li>}
          {next && <li className={styles.line}><Icon name="calendar" size={14} />{t("Next visit {when}", { when: nextWhen(next, session.company.timezone) })}</li>}
        </ul>
      )}
      <div className={styles.foot}>
        {c.owed !== null && (c.owed > 0 ? <span className={styles.owed} data-due={c.late || undefined}>{t("Owes {amount}", { amount: formatMoney(c.owed) })}</span> : <span className={styles.settled}>{t("Nothing owed")}</span>)}
        <Link className={styles.open} to={`/clients/${id}`}>{t("Open")}<Icon name="arrowRight" size={14} /></Link>
      </div>
    </>
  );
}
