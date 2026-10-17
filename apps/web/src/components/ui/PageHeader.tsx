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

export function PageHeader({ title, actions, children, documentTitle }: { title: ReactNode; actions?: ReactNode; children?: ReactNode; documentTitle?: string }) {
  useDocumentTitle(documentTitle ?? (typeof title === "string" ? title : null));
  return (
    <div className="page-header">
      {typeof title === "string" ? <h1 className="page-title">{title}</h1> : title}
      {actions && <div className="page-actions">{actions}</div>}
      {children}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="back-link no-print">
      <Icon name="arrowLeft" size={14} />
      {children}
    </Link>
  );
}
