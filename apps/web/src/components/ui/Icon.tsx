/**
 * Icons used across the app: Lucide's, plus six of Crewtavo's own for the things it's built around,
 * drawn on the same 24px grid so they take the same props. Decorative unless given a label.
 */
import {
  Archive, ArchiveRestore, ArrowLeft, AtSign, ArrowRight, Banknote, Bell, Bold, BookOpen, Calendar, CalendarCheck, Camera, ChartColumn, ChartLine, Check, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, CircleCheck, ClipboardCheck, Clock, Cloud, CodeXml, Command, Copy, CreditCard, DollarSign, Download, Ellipsis, ExternalLink, Eye, File,
  Funnel, Gauge, Gift, Globe, GripVertical, Hash, Heading, Hexagon, History, House, Image, Inbox, Info, Italic, Kanban, Landmark, Layers, LayoutGrid, Link,
  List, ListChecks, ListOrdered, Lock, LogOut, Mail, Map, MapPin, Megaphone, Menu, MessageSquareText, MessageSquareWarning, MessagesSquare, Minus, Monitor, Moon, Package, Palette, PenLine, Signature, Tablet, Type, MousePointer2, Navigation,
  Pause, Pencil, Percent, Phone, Pin, PinOff, Play, Plus, Printer, Quote, ReceiptText, Redo2, RefreshCw, Reply, Ruler, Scissors, Search, Send, SeparatorHorizontal,
  Settings, Share, Smartphone, SmilePlus, Sparkles, Spline, SquareUserRound, Star, StickyNote, Sun, Table, Tag, ThumbsUp, Trash, TriangleAlert, TriangleRight, Truck, Underline, Undo2, Upload,
  User, Users, Video, WifiOff, Wrench, X, Zap, createLucideIcon, type LucideIcon,
} from "lucide-react";

// Crewtavo's own: round caps and joins, about 2px clear of the grid's edge, and only a few strokes
// each so they still read at 14px.

/** A request: a client asking for work, as a speech bubble with a plus. */
const Request = createLucideIcon("CrewtavoRequest", [
  ["path", { d: "M7.5 16.5H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6.5L7.5 20z", key: "bubble" }],
  ["path", { d: "M12 7.5v5M9.5 10h5", key: "plus" }],
]);

/** A quote: a page with a dollar sign and the line it gets signed on. */
const QuoteDoc = createLucideIcon("CrewtavoQuote", [
  ["rect", { x: 5, y: 2, width: 14, height: 20, rx: 2, key: "page" }],
  ["path", { d: "M14.5 6H11a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9.5", key: "s" }],
  ["path", { d: "M12 5v10", key: "bar" }],
  ["path", { d: "M8.5 18.5h7", key: "sign" }],
]);

/** A job: a hard hat, ribbed, on its brim. */
const HardHat = createLucideIcon("CrewtavoJob", [
  ["path", { d: "M5 15v-2.5a7 7 0 0 1 14 0V15", key: "shell" }],
  ["path", { d: "M10 15V6.25M14 15V6.25", key: "ribs" }],
  ["path", { d: "M2.5 15h19v1.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z", key: "brim" }],
]);

/** An invoice: a page with a folded corner, a dollar sign and two short lines beside it. */
const InvoiceDoc = createLucideIcon("CrewtavoInvoice", [
  ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", key: "page" }],
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "fold" }],
  ["path", { d: "M11.5 8H9a2 2 0 0 0 0 4h1a2 2 0 0 1 0 4H7", key: "s" }],
  ["path", { d: "M9.5 6.5v11", key: "bar" }],
  ["path", { d: "M14.5 12H17M14.5 16H17", key: "lines" }],
]);

/** Paving: a road in perspective, its edges closing in toward the top, a dashed line down the middle. */
const Road = createLucideIcon("CrewtavoPaving", [
  ["path", { d: "M10 3 3 21", key: "left" }],
  ["path", { d: "m14 3 7 18", key: "right" }],
  ["path", { d: "M12 7.5V11M12 15v5", key: "dashes" }],
]);

/** Roofing: a gabled roof with two rows of shingles under the ridge. */
const Roof = createLucideIcon("CrewtavoRoofing", [
  ["path", { d: "M2 15.5 12 6.5l10 9", key: "ridge" }],
  ["path", { d: "M9 13.5h6", key: "upper" }],
  ["path", { d: "M5.5 17.5h13", key: "lower" }],
]);

const ICONS = {
  plus: Plus,
  minus: Minus,
  home: House,
  calendar: Calendar,
  calendarCheck: CalendarCheck,
  clients: SquareUserRound,
  requests: Request,
  pipeline: Kanban,
  quote: QuoteDoc,
  job: HardHat,
  invoice: InvoiceDoc,
  marketing: Megaphone,
  finance: ChartLine,
  metrics: ChartColumn,
  clock: Clock,
  bolt: Zap,
  truck: Truck,
  gauge: Gauge,
  globe: Globe,
  book: BookOpen,
  apps: LayoutGrid,
  search: Search,
  messages: MessageSquareText,
  /** AI only: asking the knowledge base, writing with AI, finding paving on the map. */
  sparkle: Sparkles,
  bell: Bell,
  settings: Settings,
  menu: Menu,
  layers: Layers,
  area: Hexagon,
  line: Spline,
  pin: MapPin,
  pointer: MousePointer2,
  trash: Trash,
  edit: Pencil,
  send: Send,
  x: X,
  check: Check,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  phone: Phone,
  mail: Mail,
  logout: LogOut,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  more: Ellipsis,
  grip: GripVertical,
  filter: Funnel,
  download: Download,
  upload: Upload,
  copy: Copy,
  star: Star,
  gift: Gift,
  alert: TriangleAlert,
  info: Info,
  external: ExternalLink,
  eye: Eye,
  image: Image,
  camera: Camera,
  video: Video,
  refresh: RefreshCw,
  archive: Archive,
  undo: Undo2,
  user: User,
  users: Users,
  tag: Tag,
  dollar: DollarSign,
  card: CreditCard,
  bank: Landmark,
  cash: Banknote,
  printer: Printer,
  play: Play,
  pause: Pause,
  list: List,
  map: Map,
  file: File,
  link: Link,
  code: CodeXml,
  lock: Lock,
  history: History,
  note: StickyNote,
  cloud: Cloud,
  navigation: Navigation,
  receipt: ReceiptText,
  percent: Percent,
  clipboard: ClipboardCheck,
  command: Command,
  inbox: Inbox,
  thumbsUp: ThumbsUp,
  wifiOff: WifiOff,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  heading: Heading,
  listOrdered: ListOrdered,
  quoteMark: Quote,
  divider: SeparatorHorizontal,
  redo: Redo2,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  share: Share,
  chat: MessagesSquare,
  hash: Hash,
  megaphone: Megaphone,
  reply: Reply,
  react: SmilePlus,
  mention: AtSign,
  onIt: CircleCheck,
  pushpin: Pin,
  unpin: PinOff,
  restore: ArchiveRestore,
  scissors: Scissors,
  smartphone: Smartphone,
  pitch: TriangleRight,
  ruler: Ruler,
  paving: Road,
  roofing: Roof,
  checklist: ListChecks,
  callout: MessageSquareWarning,
  table: Table,
  signature: Signature,
  package: Package,
  palette: Palette,
  pen: PenLine,
  type: Type,
  tablet: Tablet,
  /** A repair or a tool (equipment); a job is the hard hat. */
  wrench: Wrench,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * The sizes icons draw at. Whatever a screen asks for snaps to 12 (inside badges and dots), 14, 16, 20
 * or 24, so a page doesn't mix eighteen sizes; bigger ones are illustrations and keep theirs.
 */
export const iconSize = (size: number) => (size <= 12 ? 12 : size <= 15 ? 14 : size <= 17 ? 16 : size <= 22 ? 20 : size <= 26 ? 24 : size);

/** The stroke in screen pixels, so every size has the same weight: 1.5 up to 14px, 1.75 above, and 2 on the grid's scale for illustrations. */
const strokeFor = (size: number) => (size <= 14 ? 1.5 : size <= 26 ? 1.75 : size / 12);

/** `size` snaps to the set above (18, the default, draws at 20). `strokeWidth` is in pixels: about 2 makes a small check or cross bold. */
export function Icon({ name, size = 18, label, strokeWidth }: { name: IconName; size?: number; label?: string; strokeWidth?: number }) {
  const Glyph = ICONS[name];
  const px = iconSize(size);
  return <Glyph size={px} strokeWidth={strokeWidth ?? strokeFor(px)} absoluteStrokeWidth role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
