/** New guide: pick how to start it (blank, or one of the templates), then write it in the guide editor. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { GUIDE_TEMPLATES } from "./templates";

/** The New guide button, and the dialog it opens. `category`: filed there to start with. */
export function NewGuideButton({ category, label = "New guide", primary = true }: { category?: string | null; label?: string; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const to = (template: string | null) => `/kb/new?${new URLSearchParams({ ...(template && { template }), ...(category && { category }) })}`;
  return (
    <>
      <Button variant={primary ? "primary" : "secondary"} icon="plus" onClick={() => setOpen(true)}>{label}</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="New guide" description="Start from a template, with its headings in place, or from a blank page." size="lg">
          <div className="template-grid">
            {GUIDE_TEMPLATES.map((t) => (
              <Link key={t.key} to={to(t.key)} className="template-card">
                <span className="template-icon"><Icon name={t.icon} size={18} /></span>
                <span className="stack-sm" style={{ gap: 2 }}>
                  <strong>{t.name}</strong>
                  <span className="muted small">{t.description}</span>
                </span>
              </Link>
            ))}
            <Link to={to(null)} className="template-card" data-blank>
              <span className="template-icon"><Icon name="file" size={18} /></span>
              <span className="stack-sm" style={{ gap: 2 }}>
                <strong>Blank</strong>
                <span className="muted small">Start with an empty page.</span>
              </span>
            </Link>
          </div>
        </Dialog>
      )}
    </>
  );
}
