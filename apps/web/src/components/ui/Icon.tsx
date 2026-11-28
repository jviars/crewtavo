/**
 * Icons used across the app: Phosphor's (https://phosphoricons.com, MIT License), plus seven of
 * Crewtavo's own for things Phosphor doesn't draw, on the same 256 grid with the same round stroke so
 * they take the same weights. Decorative unless given a label.
 *
 * To add a Phosphor icon, put its name (as phosphoricons.com spells it) in ICONS and run
 * `npm run icons`, which copies its drawings into phosphor.ts.
 */
import { useId } from "react";
import { PHOSPHOR, type PhosphorName } from "./phosphor";

/**
 * One of Crewtavo's own, as strokes on Phosphor's grid (16 wide, 24 bold). Filled, `shape` turns
 * solid and `marks` are cut out of it; `lines` stay strokes, as they're outside the shape.
 */
type Own = { shape: string; marks?: string; lines?: string };

/** A request: a client asking for work, as Phosphor's centered speech bubble with a plus. */
const REQUEST: Own = {
  shape: '<path d="M40 48h176a8 8 0 0 1 8 8v128a8 8 0 0 1-8 8h-63l-25 32-25-32H40a8 8 0 0 1-8-8V56a8 8 0 0 1 8-8z"/>',
  marks: '<path d="M128 92v56M100 120h56"/>',
};

/** A quote: a page with a dollar sign and the line it gets signed on. */
const QUOTE: Own = {
  shape: '<rect x="48" y="24" width="160" height="208" rx="8"/>',
  marks: '<path d="M156 72h-40a20 20 0 0 0 0 40h24a20 20 0 0 1 0 40h-40M128 56v112M88 196h80"/>',
};

/** Roofing: a gabled roof with a row of shingles under the ridge, and the eave's row below it. */
const ROOF: Own = {
  shape: '<path d="M24 156 128 68l104 88"/>',
  marks: '<path d="M96 136h64"/>',
  lines: '<path d="M56 196h144"/>',
};

/** A salt run: a salt shaker, its cap screwed on, with three grains. */
const SALT: Own = {
  shape: '<path d="M72 88h112l-10-48H82zM72 88l-16 128h144L184 88"/>',
  marks: '<path d="M72 88h112M128 136v.01M104 172v.01M152 172v.01"/>',
};

/** A roof's pitch: rise over run, as a right triangle. */
const PITCH: Own = { shape: '<path d="M32 208h192V48z"/>' };

/** A spreadsheet: Phosphor's page with its corner folded, and a grid on it. */
const SHEET: Own = {
  shape: '<path d="M56 32h96l56 56v128a8 8 0 0 1-8 8H56a8 8 0 0 1-8-8V40a8 8 0 0 1 8-8z"/>',
  marks: '<path d="M152 32v56h56M80 128h96v64H80zM128 128v64M80 160h96"/>',
};

/** Move to a folder: Phosphor's plain folder with an arrow going in. */
const FOLDER_MOVE: Own = {
  shape: '<path d="M40 48h55.4l32 32H216a8 8 0 0 1 8 8v112a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8V56a8 8 0 0 1 8-8z"/>',
  marks: '<path d="M96 144h64M136 120l24 24-24 24"/>',
};

/** A mower (equipment, lawn work): a push mower from the side, its handle back over the deck. Phosphor has none. */
const MOWER: Own = {
  shape: '<path d="M48 176v-36a20 20 0 0 1 20-20h100a56 56 0 0 1 56 56z"/><circle cx="76" cy="196" r="24"/><circle cx="188" cy="196" r="24"/>',
  lines: '<path d="M24 32h40l36 88"/>',
};

const ICONS = {
  plus: "plus",
  minus: "minus",
  home: "house",
  calendar: "calendar-dots",
  calendarCheck: "calendar-check",
  clients: "address-book",
  requests: REQUEST,
  pipeline: "kanban",
  quote: QUOTE,
  job: "hard-hat",
  invoice: "invoice",
  marketing: "megaphone-simple",
  finance: "chart-line-up",
  metrics: "chart-bar",
  clock: "clock",
  bolt: "lightning",
  truck: "truck",
  mower: MOWER,
  gauge: "gauge",
  globe: "globe-simple",
  book: "book-open-text",
  apps: "squares-four",
  search: "magnifying-glass",
  messages: "chat-text",
  /** AI only: asking the knowledge base, writing with AI, finding paving on the map. */
  sparkle: "sparkle",
  bell: "bell",
  help: "question",
  settings: "gear-six",
  menu: "list",
  layers: "stack",
  area: "hexagon",
  line: "bezier-curve",
  pin: "map-pin",
  pointer: "cursor",
  trash: "trash",
  edit: "pencil-simple",
  send: "paper-plane-tilt",
  x: "x",
  check: "check",
  arrowLeft: "arrow-left",
  arrowRight: "arrow-right",
  /** Send, on a phone's round send button. */
  arrowUp: "arrow-up",
  phone: "phone",
  /** A call nobody answered, and one that left a voicemail (calls on a Quo number, on a client's timeline). */
  phoneMissed: "phone-x",
  voicemail: "voicemail",
  mail: "envelope-simple",
  logout: "sign-out",
  chevronRight: "caret-right",
  chevronLeft: "caret-left",
  chevronDown: "caret-down",
  chevronUp: "caret-up",
  /** The sidebar's open and close button (AppShell): two thin carets, turned to point the way it goes. */
  chevronsLeft: "caret-double-left",
  more: "dots-three",
  grip: "dots-six-vertical",
  filter: "funnel-simple",
  download: "download-simple",
  upload: "upload-simple",
  copy: "copy",
  star: "star",
  gift: "gift",
  alert: "warning",
  /** A callout that nobody can skip (the knowledge base's "important"). */
  alertCircle: "warning-circle",
  info: "info",
  external: "arrow-square-out",
  eye: "eye",
  image: "image",
  camera: "camera",
  video: "video-camera",
  refresh: "arrows-clockwise",
  archive: "archive",
  undo: "arrow-u-up-left",
  user: "user",
  users: "users",
  tag: "tag",
  dollar: "currency-dollar",
  card: "credit-card",
  bank: "bank",
  cash: "money",
  printer: "printer",
  play: "play",
  pause: "pause",
  list: "list-bullets",
  map: "map-trifold",
  file: "file",
  /** A document of words: Word, text, a rich-text file. */
  fileText: "file-text",
  link: "link",
  code: "code",
  lock: "lock",
  history: "clock-counter-clockwise",
  note: "note", // i18n-ignore: icon names, not words on screen
  cloud: "cloud",
  navigation: "navigation-arrow",
  receipt: "receipt",
  percent: "percent",
  clipboard: "clipboard-text",
  command: "command",
  inbox: "tray",
  thumbsUp: "thumbs-up",
  wifiOff: "wifi-slash",
  bold: "text-b",
  italic: "text-italic",
  underline: "text-underline",
  heading: "text-h", // i18n-ignore
  listOrdered: "list-numbers",
  quoteMark: "quotes",
  divider: "arrows-out-line-vertical",
  redo: "arrow-u-up-right",
  sun: "sun",
  moon: "moon",
  monitor: "monitor",
  share: "export",
  chat: "chats-circle",
  hash: "hash",
  megaphone: "megaphone",
  reply: "arrow-bend-up-left",
  react: "smiley",
  mention: "at",
  onIt: "check-circle",
  pushpin: "push-pin",
  unpin: "push-pin-slash",
  restore: "box-arrow-up",
  scissors: "scissors",
  smartphone: "device-mobile",
  pitch: PITCH,
  ruler: "ruler",
  calculator: "calculator",
  paving: "road-horizon",
  roofing: ROOF,
  snow: "snowflake",
  salt: SALT,
  cloudSnow: "cloud-snow",
  wind: "wind",
  thermometer: "thermometer",
  checklist: "list-checks",
  callout: "chat-centered-text",
  table: "table",
  signature: "signature",
  package: "package",
  palette: "palette",
  pen: "pencil-line",
  type: "text-t",
  tablet: "device-tablet",
  folder: "folder-simple",
  folderOpen: "folder-open",
  folderPlus: "folder-simple-plus",
  folderMove: FOLDER_MOVE,
  paperclip: "paperclip",
  hardDrive: "hard-drive",
  fileImage: "file-image",
  fileSpreadsheet: SHEET,
  zoomIn: "magnifying-glass-plus",
  zoomOut: "magnifying-glass-minus",
  maximize: "corners-out",
  minimize: "corners-in",
  highlighter: "highlighter",
  /** The photo editor's shapes. */
  circle: "circle",
  square: "square",
  arrowUpRight: "arrow-up-right",
  /** A repair or a tool (equipment); a job is the hard hat. */
  wrench: "wrench",
  /** A list's order (the sort menu beside its filters). */
  sort: "arrows-down-up",
  /** Trades, on first-run setup's tiles: landscaping, lawn care, pest control, plumbing, pools. */
  tree: "tree-evergreen",
  plant: "plant",
  bug: "bug",
  drop: "drop",
  waves: "waves",
  /** A client's page: a licensed business and an insured one. */
  certificate: "certificate",
  shieldCheck: "shield-check",
  /** Where marketing goes and where clients come from (Marketing: Social, lead and website sources). */
  facebook: "facebook-logo",
  instagram: "instagram-logo",
  google: "google-logo",
  youtube: "youtube-logo",
  tiktok: "tiktok-logo",
  xLogo: "x-logo",
  signpost: "signpost",
  mailbox: "mailbox",
  handshake: "handshake",
  gavel: "gavel",
  microphone: "microphone",
  stop: "stop",
  coffee: "coffee",
  office: "building-office",
  busy: "minus-circle",
  alarm: "alarm",
} satisfies Record<string, PhosphorName | Own>;

export type IconName = keyof typeof ICONS;

/**
 * The sizes icons draw at. Whatever a screen asks for snaps to 12 (inside badges and dots), 14, 16, 20
 * or 24, so a page doesn't mix eighteen sizes; bigger ones are illustrations and keep theirs.
 */
export const iconSize = (size: number) => (size <= 12 ? 12 : size <= 15 ? 14 : size <= 17 ? 16 : size <= 22 ? 20 : size <= 26 ? 24 : size);

type Weight = "regular" | "bold" | "fill";

const strokes = (width: number, color: string, inner: string) =>
  `<g fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;

/** One of Crewtavo's own in a weight. A filled one cuts its marks out with a mask, named by `id` so it's unique on the page. */
function drawOwn(own: Own, weight: Weight, id: string): string {
  const all = own.shape + (own.marks ?? "") + (own.lines ?? "");
  if (weight !== "fill") return strokes(weight === "bold" ? 24 : 16, "currentColor", all);
  const mask = own.marks ? `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256"><rect width="256" height="256" fill="#fff"/>${strokes(16, "#000", own.marks)}</mask>` : "";
  const solid = `<g fill="currentColor" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"${own.marks ? ` mask="url(#${id})"` : ""}>${own.shape}</g>`;
  return mask + solid + (own.lines ? strokes(16, "currentColor", own.lines) : "");
}

/**
 * `size` snaps to the set above (18, the default, draws at 20). Up to 16px an icon is drawn bold,
 * since Phosphor's regular line is too faint that small; `bold` asks for it at any size (a check that
 * should stand out). `filled` is for something selected: the screen you're on, a chosen star.
 * `className` goes on the <svg>, for a screen's rule that places or colors it; `data-icon` names it,
 * so a stage's own icon (a quote, a job) can carry the stage's color (base.css).
 */
export function Icon({ name, size = 18, label, bold, filled, className }: { name: IconName; size?: number; label?: string; bold?: boolean; filled?: boolean; className?: string }) {
  const id = `icon${useId().replace(/:/g, "")}`;
  const px = iconSize(size);
  const weight: Weight = filled ? "fill" : bold || px <= 16 ? "bold" : "regular";
  const drawing: PhosphorName | Own = ICONS[name];
  const html = typeof drawing === "string" ? PHOSPHOR[drawing][weight] : drawOwn(drawing, weight, id);
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 256 256"
      fill="currentColor"
      focusable="false"
      className={className}
      data-icon={name}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
