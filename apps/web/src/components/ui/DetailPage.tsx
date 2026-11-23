/**
 * A record's page (Page-Client.dc.html): a quiet crumb back to its list, the title with its actions
 * (one green primary, ghost secondaries, a More actions menu), a quiet line under it with the status
 * as a dot and words, then a main column and a side column of fact sections, stacked on a tablet.
 *
 * On a phone (Mobile-Work.dc.html, Client): the crumb is a round back button and the actions round
 * buttons on the same row, the title under them, and either the primary floats as the green pill
 * (the default) or the page puts its main actions in an ActionBar pinned above the tab bar.
 *
 *   <DetailHeader crumb={{ to: "/clients", label: "Clients" }} title={client.display_name}
 *     status={<EntityStatus kind="client" status={client.status} />} meta={[contact, tags]}
 *     actions={<><Button icon="plus">New request</Button><Button variant="primary" icon="plus">New quote</Button></>}
 *     more={moreItems} />
 *   <DetailColumns side={<><Section title="Details">…</Section></>}>
 *     <Section title="Properties" count={4}>…</Section>
 *   </DetailColumns>
 */
import type { ReactNode } from "react";
import { cx } from "./Button";
import { Icon, type IconName } from "./Icon";
import { MetaLine } from "./InboxList";
import { Menu, type MenuEntry } from "./Menu";
import { Crumb, useDocumentTitle } from "./PageHeader";
import { t } from "@/lib/i18n";

export { Crumb };

/** The four stages' lists: a record in one wears its stage's color and icon (components.css .detail-head[data-stage]). */
const STAGES: Record<string, IconName> = { "/requests": "requests", "/quotes": "quote", "/jobs": "job", "/invoices": "invoice" };

export function DetailHeader({ crumb, title, status, meta, actions, more, moreLabel, moreTitle, documentTitle, children }: {
  /** The list it belongs to. */
  crumb?: { to: string; label: string; state?: unknown };
  /** The record's name: a string, or your own heading (an editable title with class page-title). */
  title: ReactNode;
  /** Its state as a dot and words: an EntityStatus or StatusPill. */
  status?: ReactNode;
  /** The rest of the quiet line, after the status: a contact, tags, a date. Dots go between a list's parts; empty parts are left out. */
  meta?: ReactNode | ReactNode[];
  /** Buttons: one variant="primary", the others plain (they draw as ghosts). Give each an icon, for the phone's round buttons. */
  actions?: ReactNode;
  /** Everything else, in a More actions menu after the buttons. Danger last, after a separator. */
  more?: MenuEntry[];
  moreLabel?: string;
  /** The phone sheet's heading for the menu: the record's name. */
  moreTitle?: string;
  documentTitle?: string;
  /** Under the meta line, full width: a banner that belongs to the header (a callout). */
  children?: ReactNode;
}) {
  useDocumentTitle(documentTitle ?? (typeof title === "string" ? title : null));
  const metaParts = [status, ...(Array.isArray(meta) ? meta : [meta])];
  const hasMeta = metaParts.some((p) => p !== null && p !== undefined && p !== false && p !== "");
  const stage = crumb ? STAGES[crumb.to.split(/[?#]/)[0]!] : undefined;
  return (
    <div className="page-header detail-head" data-stage={stage}>
      {crumb && <div className="detail-crumb"><Crumb to={crumb.to} state={crumb.state}>{stage && <Icon name={stage} size={16} />}{crumb.label}</Crumb></div>}
      {typeof title === "string" ? <h1 className="page-title">{title}</h1> : title}
      {(actions || more) && (
        <div className="page-actions">
          {actions}
          {more && <Menu items={more} label={moreLabel ?? t("More actions")} title={moreTitle ?? (typeof title === "string" ? title : undefined)} />}
        </div>
      )}
      {hasMeta && <MetaLine className="detail-meta" parts={metaParts} />}
      {children}
    </div>
  );
}

/**
 * The body: the main column and, beside it, a 300–340px column of fact sections; one column on a
 * tablet or phone (the side after the main, unless `sideFirst`). `grouped` gives a phone the kit's
 * grouped look: a grey ground with each Section an inset white card under a small heading.
 */
export function DetailColumns({ children, side, grouped, sideFirst, className }: { children: ReactNode; side?: ReactNode; grouped?: boolean; sideFirst?: boolean; className?: string }) {
  return (
    <div className={cx("detail-cols", !side && "detail-cols-one", grouped && "m-grouped", sideFirst && "detail-side-first", className)}>
      <div className="detail-main">{children}</div>
      {side && <aside className="detail-side">{side}</aside>}
    </div>
  );
}

/**
 * A phone's main actions, pinned above the tab bar within thumb reach: a green primary and one or two
 * quiet ones (Mobile-Work.dc.html, Client). Only on a phone; a desktop has the header's buttons, so
 * give those className="hide-mobile" when the bar repeats them.
 */
export function ActionBar({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="action-bar" role="group" aria-label={label ?? t("Actions")}>
      {children}
    </div>
  );
}
