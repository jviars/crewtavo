/** "How to measure": shown the first time someone opens Measure, and from the ? button after. */
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon, type IconName } from "@/components/ui/Icon";

const SEEN_KEY = "crewtavo.measureHelpSeen";

export function helpSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // storage blocked: don't pop it up every time
  }
}

export function markHelpSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* nothing to remember it in */
  }
}

const STEPS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: "search", title: "Find the property", body: "Type an address in the search box, or open Measure from a client, request, quote or invoice and it starts there." },
  { icon: "area", title: "Outline what you're measuring", body: "Area for lawns, roofs, lots and driveways. Line for edges, fences and curbs. Count for trees, drains or posts. Sizes show on the map as you go." },
  { icon: "check", title: "Save, then share it", body: "Saving keeps a picture of the drawing. Put it on a quote or invoice, and choose whether the client sees it there." },
];

export function MeasureHelp({ open, onClose, touch }: { open: boolean; onClose: () => void; touch: boolean }) {
  const tap = touch ? "Tap" : "Click";
  return (
    <Dialog open={open} onClose={onClose} title="How to measure" description="Three steps, and a few tips that save time.">
      <div className="dialog-body stack">
        <ol className="measure-help-steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <span className="measure-help-icon" aria-hidden="true"><Icon name={s.icon} size={18} /></span>
              <span className="grow"><strong>{s.title}</strong><span className="muted">{s.body}</span></span>
            </li>
          ))}
        </ol>
        <div className="callout">
          <Icon name="info" size={18} />
          <div className="grow stack-sm">
            <span>Tips</span>
            <ul className="measure-help-tips">
              <li>{tap} the first point (or press Enter) to close an area. Double-{tap.toLowerCase()} finishes a line.</li>
              <li>Made a mistake? Undo takes back the last point while you draw{touch ? "" : " (Ctrl+Z or ⌘Z)"}. {touch ? "Cancel" : "Esc"} drops the shape you're drawing.</li>
              <li>Edit lets you drag corners. Drag the small dots between corners to add one.</li>
              <li>The map starts on Auto, which picks the sharpest free imagery for wherever you are. The Imagery button lets you choose a source yourself, switch to Terrain, or lay slope and 2 ft contour lines over the map (US).</li>
              <li>New site where the aerial still shows dirt? Under Plan on the map, put the site plan on the map, line it up by {touch ? "tapping" : "clicking"} the same two spots on the plan and the aerial, and draw over it.</li>
              {!touch && <li>Shortcuts: A area, L line, C count, E edit, F fit to shapes, Delete removes the selected shape.</li>}
            </ul>
          </div>
        </div>
        <div className="form-actions">
          <Button variant="primary" onClick={onClose}>Got it</Button>
        </div>
      </div>
    </Dialog>
  );
}
