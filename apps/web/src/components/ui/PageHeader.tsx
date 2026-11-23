import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

/** Sets the browser tab title, e.g. "Quotes · Crewtavo". */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · Crewtavo`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/**
 * A screen's title (24px, a phone's 30px), its actions on the right and an optional lede under it: one
 * quiet line saying what the screen is for. In `actions`, the one primary is a Button variant="primary";
 * the others draw as ghosts (components.css), and an icon-only one, like a Menu, keeps its hairline.
 *
 * On a phone (components.css, max-width 900px) the primary floats over the list above the tab bar as
 * the green pill (.fab), and the other actions sit beside the title as round 40px buttons: one with an
 * icon shows only the icon, its words kept as its name. So give each secondary action an icon.
 */
export function PageHeader({ title, actions, lede, children, documentTitle }: { title: ReactNode; actions?: ReactNode; lede?: ReactNode; children?: ReactNode; documentTitle?: string }) {
  useDocumentTitle(documentTitle ?? (typeof title === "string" ? title : null));
  return (
    <div className="page-header">
      {typeof title === "string" ? <h1 className="page-title">{title}</h1> : title}
      {actions && <div className="page-actions">{actions}</div>}
      {lede && <p className="page-lede">{lede}</p>}
      {children}
    </div>
  );
}

/**
 * The way back to the list a record is in: quiet words after a chevron pointing back, over the title.
 * On a phone, a round back button whose name is still the list's ("Clients"). DetailHeader's crumb is this.
 */
export function Crumb({ to, children, state, className }: { to: string; children: ReactNode; state?: unknown; className?: string }) {
  return (
    <Link to={to} state={state} className={className ? `crumb no-print ${className}` : "crumb no-print"}>
      <Icon name="chevronLeft" size={20} />
      <span className="crumb-text">{children}</span>
    </Link>
  );
}

/** A crumb on its own over a page's header, for a page that doesn't use DetailHeader. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <Crumb to={to} className="back-link">{children}</Crumb>;
}
