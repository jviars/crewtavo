/**
 * Starting points for a new guide (New guide → pick one). Each is the guide editor's own HTML
 * (headings, steps, checklists, callouts), with short prompts to write over.
 */
import type { IconName } from "@/components/ui/Icon";

export interface GuideTemplate {
  key: string;
  name: string;
  /** What it's for, on its card. */
  description: string;
  icon: IconName;
  /** The title box's example. */
  titleHint: string;
  html: string;
}

const checklist = (items: string[]) => `<ul data-type="taskList">${items.map((i) => `<li data-type="taskItem" data-checked="false"><p>${i}</p></li>`).join("")}</ul>`;
const steps = (items: string[]) => `<ol>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ol>`;
const bullets = (items: string[]) => `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ul>`;

export const GUIDE_TEMPLATES: readonly GuideTemplate[] = [
  {
    key: "task",
    name: "Step-by-step task",
    description: "How to do one job, start to finish.",
    icon: "listOrdered",
    titleHint: "e.g. Request a certificate of insurance",
    html:
      "<h2>When to use this guide</h2><p>The job or situation this is for.</p>" +
      `<h2>Before you start</h2>${bullets(["Tools, materials or paperwork you'll need"])}` +
      `<h2>Steps</h2>${steps(["First step", "Next step", "Last step"])}` +
      `<h2>Done when</h2>${checklist(["What a finished job looks like"])}` +
      '<h2>If something goes wrong</h2><div data-callout="warning"><p>Who to call, and what not to do.</p></div>',
  },
  {
    key: "job",
    name: "Job description",
    description: "What a role does, each duty linked to its how-to.",
    icon: "users",
    titleHint: "e.g. Office administrator",
    html:
      "<p>A sentence or two on what this job is for.</p>" +
      `<h2>What you'll do</h2>${bullets(["A duty. Select it and press ⌘K to link the guide for how it's done.", "Another duty"])}` +
      `<h2>What we're looking for</h2>${bullets(["Experience, skills or licenses the job needs"])}` +
      "<h2>Who they work with</h2><p>Who they report to, and who they hand work to.</p>",
  },
  {
    key: "safety",
    name: "Safety procedure",
    description: "Hazards, gear and steps. Add a quiz and make it required.",
    icon: "alert",
    titleHint: "e.g. Working near traffic",
    html:
      '<div data-callout="important"><p>Stop and ask if anything here doesn\'t match the job in front of you.</p></div>' +
      `<h2>Hazards</h2>${bullets(["What can hurt someone on this job"])}` +
      `<h2>Protective gear</h2>${checklist(["Gear everyone wears"])}` +
      `<h2>Steps</h2>${steps(["First step", "Next step"])}` +
      "<h2>In an emergency</h2><p>Who to call, and where the first-aid kit and fire extinguisher are.</p>",
  },
  {
    key: "equipment",
    name: "Equipment",
    description: "Daily checks, running it, and shutting it down.",
    icon: "wrench",
    titleHint: "e.g. Sealcoat sprayer",
    html:
      `<h2>Before you start it</h2>${checklist(["Fluids topped up", "Guards and hoses in place"])}` +
      `<h2>Running it</h2>${steps(["Start-up", "Use"])}` +
      `<h2>Shutting down and cleaning</h2>${steps(["Shut-down", "Cleaning"])}` +
      "<h2>Who to call</h2><p>For repairs, parts or a breakdown on a job.</p>",
  },
];

export const templateFor = (key: string | null) => GUIDE_TEMPLATES.find((t) => t.key === key) ?? null;
