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
  { icon: "area", title: "Outline what you're measuring", body: "Pick a tool in the dock under the map: Area for lawns, roofs, lots and driveways, Line for edges, fences and curbs, Count for trees, drains or posts. Sizes show on the map and in the panel as you go." },
  { icon: "scissors", title: "Cut out what isn't part of it", body: "Measured the whole yard? Cut out the house, a pool or a bed and it comes off the areas under it. Cut out buildings does the house for you where OpenStreetMap has it." },
  { icon: "check", title: "Save, then share it", body: "Saving keeps a picture of the drawing. At the foot of the panel, put it on a quote or invoice and choose whether the client sees it there." },
];

/** The keys, on a keyboard (MeasurePage's own: the tools' letters and the rest). */
const SHORTCUTS: Array<[string, string]> = [
  ["V", "Select"],
  ["A", "Area"],
  ["L", "Line"],
  ["C", "Count"],
  ["X", "Cut out"],
  ["Enter", "Finish the shape"],
  ["F", "Fit to shapes"],
  ["Delete", "Remove the selected shape"],
  ["Ctrl Z", "Undo"],
  ["?", "This help"],
];

export function MeasureHelp({ open, onClose, touch }: { open: boolean; onClose: () => void; touch: boolean }) {
  const tap = touch ? "Tap" : "Click";
  return (
    <Dialog open={open} onClose={onClose} title="How to measure" description="Four steps, and a few tips that save time.">
      <div className="dialog-body stack">
        <ol className="measure-help-steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <span className="measure-help-icon" aria-hidden="true"><Icon name={s.icon} size={16} /></span>
              <span className="grow"><strong>{s.title}</strong><span>{s.body}</span></span>
            </li>
          ))}
        </ol>
        <section className="measure-help-more" aria-labelledby="measure-help-tips">
          <h3 id="measure-help-tips">Tips</h3>
          <ul className="measure-help-tips">
            <li>{tap} the first point to close an area, or press Finish{touch ? "" : " (or Enter)"} on the bar over the dock. Double-{tap.toLowerCase()} finishes a line.{touch ? " On a phone you can also move the map under the cross and tap Add point, so your finger doesn't cover the corner." : ""}</li>
            <li>Made a mistake? Undo takes back the last point while you draw{touch ? "" : " (Ctrl+Z or ⌘Z)"}. {touch ? "Cancel" : "Esc"} drops the shape you're drawing.</li>
            <li>Select picks a shape: its card shows its size and sides, what it is, and Make it a cutout and Delete. Drag its corners to move them; drag the small dots between corners to add one.</li>
            <li>Roofs: set the pitch in the panel (Set the pitch, or Roof pitch and edges). From lidar reads it from free USGS lidar for each roof you've drawn, without leaving the office; or measure it with your phone on the roof or from a photo. A porch or dormer at another pitch gets its own from its card or its row. Mark lines as eaves, rakes, ridges, hips or valleys for drip edge and ridge cap.</li>
            <li>Lawns: draw the lawn with Area, then pick Bed, Edging, Tree or Obstacle under Next shape to mark them; a general, landscaping, handyman or pest control business opens Lawn under the list first. The slope of the ground under each lawn comes from free USGS elevation in the US, whatever imagery is on the map; elsewhere from Google while the map shows Google satellite, when it's turned on in Settings, Maps. Where neither has it, pick Flat, Hilly or Steep on the lawn's card. Price formulas can use all of it: slope_pct, steep_pct, bed_sqft, edging_ft, trees and obstacles.</li>
            <li>The map starts on Auto, which picks the sharpest imagery for wherever you are (Google satellite, when your team added a Google key). The Imagery button lets you choose a source yourself, switch to Terrain, lay slope and 2 ft contour lines over the map (US), and turn street names and house numbers on or off.</li>
            {touch && <li>On a phone the map fills the screen and the panel sits under it: pull it up for everything you've drawn.</li>}
            <li>New site where the aerial still shows dirt? Under Site plan on the map, put the site plan on the map, line it up by {touch ? "tapping" : "clicking"} the same two spots on the plan and the aerial, and draw over it.</li>
          </ul>
        </section>
        {!touch && (
          <section className="measure-help-more" aria-labelledby="measure-help-keys">
            <h3 id="measure-help-keys">Shortcuts</h3>
            <dl className="measure-help-keys">
              {SHORTCUTS.map(([key, what]) => (
                <div key={key}>
                  <dt>{key.split(" ").map((k) => <kbd key={k} className="kbd">{k}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <div className="form-actions">
          <Button variant="primary" onClick={onClose}>Got it</Button>
        </div>
      </div>
    </Dialog>
  );
}
