/** New guide: pick how to start it (a blank page, or one of the templates), then write it in the guide editor. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon, type IconName } from "@/components/ui/Icon";
import s from "./kbWrite.module.css";
import { GUIDE_TEMPLATES } from "./templates";

/** The New guide button, and the dialog it opens. `category`: filed there to start with. */
export function NewGuideButton({ category, label = "New guide", primary = true, className }: { category?: string | null; label?: string; primary?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const to = (template: string | null) => `/kb/new?${new URLSearchParams({ ...(template && { template }), ...(category && { category }) })}`;
  const start = (key: string | null, icon: IconName, name: string, description: string) => (
    <Link key={key ?? "blank"} to={to(key)} className={s.start}>
      <span className={s.startIcon} aria-hidden="true"><Icon name={icon} size={17} /></span>
      <span>
        <span className={s.startName}>{name}</span>
        <span className={s.startDesc}>{description}</span>
      </span>
      <Icon name="chevronRight" size={16} />
    </Link>
  );
  return (
    <>
      <Button variant={primary ? "primary" : "secondary"} icon="plus" className={className} onClick={() => setOpen(true)}>{label}</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="New guide" description="Start from a template, with its headings in place, or from a blank page.">
          <nav className={s.starts} aria-label="How to start it">
            {start(null, "plus", "Blank page", "Start with an empty page.")}
            <div className={s.startHead} aria-hidden="true">Templates</div>
            {GUIDE_TEMPLATES.map((t) => start(t.key, t.icon, t.name, t.description))}
          </nav>
        </Dialog>
      )}
    </>
  );
}
