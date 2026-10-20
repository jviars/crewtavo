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
  { icon: "scissors", title: "Cut out what isn't part of it", body: "Measured the whole yard? Cut out the house, a pool or a bed and it comes off the areas under it. Cut out buildings does the house for you where OpenStreetMap has it." },
  { icon: "check", title: "Save, then share it", body: "Saving keeps a picture of the drawing. Put it on a quote or invoice, and choose whether the client sees it there." },
];

export function MeasureHelp({ open, onClose, touch }: { open: boolean; onClose: () => void; touch: boolean }) {
  const tap = touch ? "Tap" : "Click";
  return (
    <Dialog open={open} onClose={onClose} title="How to measure" description="Four steps, and a few tips that save time.">
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
              <li>Edit lets you drag corners. Drag the small dots between corners to add one. Pick an area in Edit and press Cut out to turn it into a cutout.</li>
              <li>Roofs: set the pitch under Roof pitch and edges. From lidar reads it from free USGS lidar for each roof you've drawn, without leaving the office; or measure it with your phone on the roof or from a photo. A porch or dormer at another pitch gets its own from its row in Shapes. Mark lines as eaves, rakes, ridges, hips or valleys for drip edge and ridge cap.</li>
              <li>The map starts on Auto, which picks the sharpest free imagery for wherever you are. The Imagery button lets you choose a source yourself, switch to Terrain, lay slope and 2 ft contour lines over the map (US), and turn street names and house numbers on or off.</li>
              <li>New site where the aerial still shows dirt? Under Plan on the map, put the site plan on the map, line it up by {touch ? "tapping" : "clicking"} the same two spots on the plan and the aerial, and draw over it.</li>
              {!touch && <li>Shortcuts: A area, X cut out, L line, C count, E edit, F fit to shapes, Delete removes the selected shape.</li>}
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
