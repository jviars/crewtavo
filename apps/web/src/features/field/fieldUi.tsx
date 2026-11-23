/**
 * The crew's screens share one header (Mobile-Work.dc.html, My day): a quiet line over a large title,
 * such as the day's date over "My day" or the sub's business over "My jobs". The screens wrap
 * themselves in `.field-app m-grouped`, so on a phone the page gets the kit's grey ground and each
 * Section is an inset card under a small heading.
 */
import type { ReactNode } from "react";

export function FieldHeader({ kicker, title, children }: { kicker?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header field-head">
      {kicker && <div className="field-kicker">{kicker}</div>}
      {typeof title === "string" ? <h1 className="page-title">{title}</h1> : title}
      {children}
    </div>
  );
}
