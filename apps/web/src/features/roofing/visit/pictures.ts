/**
 * A drawing of what a price list item is (a pipe boot on a slope of shingles, a chimney with its
 * flashing, a sheet of rotten decking), for the pictures the salesperson taps to add work on the
 * iPad (VisitPicks). Picked by the item's name, as the roofing price list names them (core presets
 * roofing_exteriors), with a house for anything else. The drawings are static markup, drawn by
 * VisitPicks and colored by the tokens in picks.module.css, so dark mode follows.
 */
export type PictureKey =
  | "pipeBoot"
  | "boxVent"
  | "powerVent"
  | "ridgeVent"
  | "ridgeCap"
  | "iceWater"
  | "chimneyFlash"
  | "cricket"
  | "decking"
  | "reflash"
  | "skylight"
  | "gutterOffOn"
  | "gutters"
  | "guards"
  | "satellite"
  | "solar"
  | "twoStory"
  | "lowSlope"
  | "steep"
  | "permit"
  | "dumpster"
  | "tearOff"
  | "dripEdge"
  | "valley"
  | "house";

/** Words in an item's name and the drawing they mean, the first that matches winning. */
const MATCHES: ReadonlyArray<[RegExp, PictureKey]> = [
  [/pipe\s*(boot|jack|collar|flash)|plumbing\s*vent|\bboots?\b/, "pipeBoot"],
  [/ridge\s*vent/, "ridgeVent"],
  [/power\s*vent|attic\s*fan|turbine/, "powerVent"],
  [/(box|roof|static|exhaust|intake|soffit)\s*vent|\bvents?\b/, "boxVent"],
  [/ridge\s*cap|hip\s*(and|&)\s*ridge|\bhips?\b/, "ridgeCap"],
  [/ice\s*(and|&)\s*water|ice\s*shield|underlayment|\bfelt\b/, "iceWater"],
  [/cricket|saddle/, "cricket"],
  [/chimney/, "chimneyFlash"],
  [/decking|(rotten|roof)\s*deck|plywood|\bosb\b|sheathing/, "decking"],
  [/reflash.*skylight|skylight.*flash/, "reflash"],
  [/skylight/, "skylight"],
  [/gutters?\s*(off|detach|remove|reset|r&r)|(detach|reset).*gutter/, "gutterOffOn"],
  [/(gutter|leaf)\s*guard/, "guards"],
  [/gutter|downspout/, "gutters"],
  [/satellite|\bdish\b|antenna/, "satellite"],
  [/solar/, "solar"],
  [/two\s*stor|2\s*stor|second\s*stor|stories|\bstory\b/, "twoStory"],
  [/low[\s-]*slope|flat\s*roof|\btpo\b|\bepdm\b|modified\s*bitumen/, "lowSlope"],
  [/steep|high\s*pitch/, "steep"],
  [/permit/, "permit"],
  [/tear[\s-]*off|remove\s*(old\s*)?(shingles|roof)/, "tearOff"],
  [/dumpster|haul|debris/, "dumpster"],
  [/drip\s*edge|starter|\brake\b|\beaves?\b/, "dripEdge"],
  [/valley/, "valley"],
];

/** The drawing for an item, by its name: a house for anything not drawn. */
export function pictureFor(name: string): PictureKey {
  const text = name.toLowerCase();
  return MATCHES.find(([words]) => words.test(text))?.[1] ?? "house";
}

const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");

// A slope of shingles across the bottom, for the things that sit on a roof.
const ROOF =
  '<path class="rf o" d="M-4 94 L-4 54.6 L124 36 L124 94 Z"/>' +
  '<path class="rl" d="M-4 64.6 L124 46 M-4 74.6 L124 56 M-4 84.6 L124 66 M15 51.8 v10 M45 47.4 v10 M75 43 v10 M105 38.6 v10 M30 59.6 v10 M60 55.2 v10 M90 50.8 v10 M15 71.8 v10 M45 67.4 v10 M75 63 v10 M105 58.6 v10 M30 79.6 v12 M60 75.2 v12 M90 70.8 v12"/>';
// Looking along a ridge.
const RIDGE =
  '<path class="rf2 o" d="M8 36 L112 36 L104 14 L16 14 Z"/>' +
  '<path class="rf o" d="M-4 94 L124 94 L112 36 L8 36 Z"/>' +
  '<path class="rl" d="M5.2 50 L114.8 50 M2.4 64 L117.6 64 M-0.4 78 L120.4 78 M15 50 v14 M45 50 v14 M75 50 v14 M105 50 v14 M30 64 v14 M60 64 v14 M90 64 v14 M15 78 v16 M45 78 v16 M75 78 v16 M105 78 v16"/>';
// The eave: shingles, the fascia, a gutter and the wall under it.
const eave = (gutter: string, extra = "") =>
  '<path class="rf o" d="M-4 4 L124 4 L124 36 L-4 36 Z"/>' +
  '<path class="rl" d="M-4 15 H124 M-4 26 H124 M20 4 v11 M50 4 v11 M80 4 v11 M110 4 v11 M35 15 v11 M65 15 v11 M95 15 v11 M20 26 v10 M50 26 v10 M80 26 v10 M110 26 v10"/>' +
  '<rect class="wh o" x="-4" y="36" width="128" height="9"/>' +
  '<rect class="wall" x="-4" y="45" width="128" height="50"/>' +
  '<path class="sl" d="M-4 62 H124 M-4 73 H124 M-4 84 H124"/>' +
  `<path class="${gutter} o" d="M-4 37 L124 37 L124 50 Q124 54 120 54 L-4 54 Z"/>` +
  '<path class="dl" d="M-4 41 H124"/>' +
  `<path class="${gutter} o" d="M92 53 H102 V95 H92 Z"/>` +
  extra;
const GLASS =
  '<path class="mt o" d="M38 72.5 L84 65.8 L79.5 36 L42.5 41.3 Z"/>' +
  '<path class="gl o" d="M44 68 L78 63 L74.5 41 L47.5 45 Z"/>' +
  '<path class="glare" d="M54 62 L60 47 M62 61 L66 51"/>';
// A brick chimney standing on the slope: its front, the side going up the roof, and its top.
function chimney(x: number, w: number, top: number) {
  const r = x + w;
  const by = 66 - (x - 42) * 0.145;
  const bry = by - w * 0.145;
  const mortar =
    range(5, (i) => `M${x} ${top + 10 + i * 10} H${r} `) +
    `M${x + w / 2} ${top} V${top + 10} M${x + w / 4} ${top + 10} V${top + 20} M${x + (3 * w) / 4} ${top + 10} V${top + 20} M${x + w / 2} ${top + 20} V${top + 30} M${x + w / 4} ${top + 30} V${top + 40} M${x + (3 * w) / 4} ${top + 30} V${top + 40} ` +
    range(4, (i) => `M${r} ${top + 10 + i * 10} L${r + 11} ${top + 6 + i * 10} `);
  return (
    `<path class="br o" d="M${x} ${by} L${r} ${bry} L${r} ${top} L${x} ${top} Z"/>` +
    `<path class="br2 o" d="M${r} ${bry} L${r + 11} ${bry - 6.5} L${r + 11} ${top - 4} L${r} ${top} Z"/>` +
    `<path class="br3 o" d="M${x} ${top} L${r} ${top} L${r + 11} ${top - 4} L${x + 11} ${top - 4} Z"/>` +
    `<path class="mo" d="${mortar}"/>`
  );
}

const DRAWINGS: Record<PictureKey, string> = {
  pipeBoot:
    ROOF +
    '<path class="mt o" d="M36 72 L84 65 L80 53 L40 59 Z"/>' +
    '<path class="dk o" d="M48 63 Q60 66.5 72 61 L66.5 40 L53.5 41 Z"/>' +
    '<rect class="wh o" x="54" y="14" width="12" height="27"/>' +
    '<ellipse class="wh o" cx="60" cy="14" rx="6" ry="2.2"/><ellipse class="dk" cx="60" cy="14" rx="3.6" ry="1.2"/>' +
    '<ellipse class="dk2 o" cx="60" cy="41" rx="7.2" ry="2.6"/>',
  boxVent:
    ROOF +
    '<path class="mt o" d="M30 73 L90 64 L86 50 L34 57 Z"/>' +
    '<path class="mt2 o" d="M41 53 L79 47.5 L74 33 L46 37 Z"/>' +
    '<path class="mt o" d="M41 65 L79 59.5 L79 47.5 L41 53 Z"/>' +
    '<path class="dl" d="M45 57.5 L75 53.2 M45 61.5 L75 57.2"/>',
  powerVent:
    ROOF +
    '<path class="mt o" d="M28 75 L92 65.5 L87 49 L33 57 Z"/>' +
    '<path class="mt2 o" d="M37 64.5 C37 42 48 30 60 30 C73 30 83 40 83 57.8 Z"/>' +
    '<path class="dl" d="M40 52 Q60 45 81 45 M44 41 Q60 36 77 36"/>' +
    '<ellipse class="mt o" cx="60" cy="30" rx="9" ry="3"/>' +
    '<path class="spark o" d="M63 43 L55 54 L60 54 L57 62 L66 50.5 L61 50.5 L65 43 Z"/>',
  ridgeVent: RIDGE + '<rect class="dk o" x="10" y="28" width="100" height="13" rx="5"/>' + `<path class="slot" d="${range(13, (i) => `M${18 + i * 7} 32 v5 `)}"/>`,
  ridgeCap: RIDGE + range(9, (i) => `<rect class="rf3 o" x="${7 + i * 11.8}" y="27" width="13" height="13" rx="2"/>`),
  iceWater:
    ROOF +
    '<path class="dk o" d="M4 81 L70 71.4 L66 58.2 L0 67.8 Z"/>' +
    '<path class="ml" d="M3 73.5 L68 64"/>' +
    '<ellipse class="dk2 o" cx="64" cy="61" rx="5" ry="9"/>' +
    '<path class="dk o" d="M64 70 L106 63.9 L106 45.9 L64 52 Z"/>' +
    '<path class="hi" d="M79 67.8 L89 66.3 L89 48.3 L79 49.8 Z"/>' +
    '<ellipse class="dk2 o" cx="106" cy="54.9" rx="5" ry="9"/>' +
    '<ellipse class="ml" cx="106" cy="54.9" rx="2.4" ry="4.4"/>',
  chimneyFlash: ROOF + chimney(42, 32, 16) + '<path class="hi o" d="M38 70.5 L78 64.7 L78 58 L38 63.8 Z"/>' + '<path class="hi o" d="M78 64.7 L90 57.8 L90 51 L78 58 Z"/>',
  cricket: ROOF + '<path class="hi o" d="M60 52 L106 45.5 L92 28 L74 31 Z"/>' + '<path class="ln" d="M92 28 L80 33"/>' + chimney(44, 26, 22) + '<path class="mt o" d="M40 70.2 L74 65.3 L74 59.6 L40 64.5 Z"/>',
  decking:
    ROOF +
    '<path class="wd o" d="M12 80 L100 67.2 L92 30 L20 40.5 Z"/>' +
    '<path class="wg" d="M19 50 Q50 44 95 39 M17 60 Q55 52 97 49 M15 70 Q50 64 98.5 58"/>' +
    '<path class="dl" d="M58 74 L54 35"/>' +
    '<path class="rot" d="M64 60 C60 52 69 46 77 49 C84 44 93 50 90 57 C94 63 83 69 76 65 C69 69 62 66 64 60 Z"/>' +
    '<path class="crack" d="M70 57 L76 53.5 L80 56.5 M78 61 L84 63"/>',
  reflash: ROOF + '<path class="hi o" d="M32 77 L90 68.6 L84 31 L38 37.5 Z"/>' + GLASS,
  skylight:
    ROOF +
    GLASS +
    '<path class="spark" d="M96 12 l2.2 6.3 l6.3 2.2 l-6.3 2.2 l-2.2 6.3 l-2.2 -6.3 l-6.3 -2.2 l6.3 -2.2 z"/>' +
    '<path class="spark" d="M22 16 l1.4 3.8 l3.8 1.4 l-3.8 1.4 l-1.4 3.8 l-1.4 -3.8 l-3.8 -1.4 l3.8 -1.4 z"/>',
  gutterOffOn: eave("mt2", '<path class="arw" d="M28 88 V64 M21 71 L28 64 L35 71 M52 64 V88 M45 81 L52 88 L59 81"/>'),
  gutters: eave("hi", '<path class="spark" d="M30 66 l1.8 5 l5 1.8 l-5 1.8 l-1.8 5 l-1.8 -5 l-5 -1.8 l5 -1.8 z"/>'),
  guards: eave("mt2", '<path class="hi o" d="M-4 33 H124 V40 H-4 Z"/>' + `<path class="mesh" d="${range(17, (i) => `M${-4 + i * 8} 33 l7 7 M${3 + i * 8} 33 l-7 7 `)}"/>`),
  satellite:
    ROOF +
    '<path class="mt o" d="M50 68 L72 64.8 L69 58.5 L53 61 Z"/>' +
    '<path class="ln" d="M61 62 L61 46 M61 50 L52 43"/>' +
    '<ellipse class="wh o" cx="50" cy="34" rx="21" ry="14" transform="rotate(-24 50 34)"/>' +
    '<ellipse class="mt" cx="50" cy="34" rx="15" ry="9.5" transform="rotate(-24 50 34)"/>' +
    '<path class="ln" d="M52 40 L82 22"/>' +
    '<circle class="dk o" cx="84" cy="21" r="4"/>',
  solar:
    ROOF +
    '<path class="sol o" d="M18 80 L102 67.8 L94 34 L26 43.9 Z"/>' +
    '<path class="soll" d="M60 73.9 L60 38.9 M22 62 L98 50.9 M39 76.9 L43 41.4 M81 70.8 L77 36.5 M20 71 L100 59.4 M24 53 L96 42.5"/>' +
    '<path class="glare faint" d="M68 63 L74 50"/>',
  twoStory:
    '<path class="gnd" d="M0 87 H120"/>' +
    '<rect class="wall o" x="26" y="38" width="62" height="49"/>' +
    '<path class="rf o" d="M18 40 L57 12 L96 40 Z"/>' +
    '<rect class="gl o" x="34" y="46" width="12" height="12"/><rect class="gl o" x="68" y="46" width="12" height="12"/>' +
    '<rect class="gl o" x="34" y="67" width="12" height="12"/><rect class="gl o" x="68" y="67" width="12" height="12"/>' +
    '<rect class="dk2 o" x="52" y="65" width="11" height="22"/>' +
    '<path class="lad" d="M100.6 88 L91 30 M110.6 88 L101 30 M99.3 80 H109.3 M97.6 70 H107.6 M96 60 H106 M94.3 50 H104.3 M92.7 40 H102.7"/>' +
    '<path class="arw" d="M11 84 V16 M6 22 L11 16 L16 22 M6 78 L11 84 L16 78"/>',
  lowSlope:
    '<path class="gnd" d="M0 87 H120"/>' +
    '<rect class="wall o" x="10" y="40" width="54" height="47"/>' +
    '<path class="rf o" d="M3 42 L37 14 L71 42 Z"/>' +
    '<rect class="wall o" x="64" y="54" width="50" height="33"/>' +
    '<path class="hi o" d="M62 47 L118 53 L118 58 L62 52 Z"/>' +
    '<rect class="gl o" x="22" y="56" width="12" height="12"/><rect class="gl o" x="80" y="64" width="14" height="11"/>' +
    '<text x="88" y="44">2/12</text>',
  steep:
    '<path class="gnd" d="M0 87 H120"/>' +
    '<rect class="wall o" x="32" y="56" width="56" height="31"/>' +
    '<path class="rf o" d="M24 58 L60 8 L96 58 Z"/>' +
    '<path class="rl" d="M31 48 H89 M38 38 H82 M45 28 H75"/>' +
    '<rect class="dk2 o" x="54" y="68" width="12" height="19"/>' +
    '<path class="arw" d="M100 58 A 18 18 0 0 0 91 44"/>' +
    '<text x="98" y="40">12/12</text>',
  permit:
    '<rect class="wd o" x="30" y="10" width="60" height="76" rx="5"/>' +
    '<rect class="wh o" x="36" y="17" width="48" height="63" rx="2"/>' +
    '<rect class="mt o" x="47" y="5" width="26" height="10" rx="3"/>' +
    '<path class="dl" d="M42 30 H76 M42 38 H72 M42 46 H66 M42 54 H70"/>' +
    '<circle class="stamp" cx="70" cy="68" r="9"/><path class="stamp" d="M65.5 68 L68.8 71.3 L74.8 65"/>',
  dumpster:
    '<path class="gnd" d="M0 88 H120"/>' +
    '<path class="rf o" d="M20 44 L40 33 L45 38 L26 47 Z"/>' +
    '<path class="rf2 o" d="M44 45 L62 30 L67 34 L51 47 Z"/>' +
    '<path class="wd o" d="M84 44 L98 25 L102 27 L90 46 Z"/>' +
    '<path class="rf o" d="M66 46 L90 37 L92 42 L72 48 Z"/>' +
    '<path class="dump o" d="M8 46 L112 46 L104 82 L16 82 Z"/>' +
    '<path class="dl" d="M32 47 V81 M52 47 V81 M72 47 V81 M90 47 V81"/>' +
    '<rect class="dump2 o" x="5" y="42" width="110" height="7" rx="2"/>' +
    '<circle class="dk o" cx="26" cy="84" r="4.5"/><circle class="dk o" cx="94" cy="84" r="4.5"/>',
  tearOff:
    ROOF +
    '<path class="wd o" d="M64 58 L124 49.3 L124 94 L84 94 Z"/>' +
    '<path class="wg" d="M72 71 L124 63.4 M79 84 L124 77.5"/>' +
    '<path class="rf2 o" d="M48 63 L66 60.4 L72 47 L54 49.6 Z"/>' +
    '<path class="rf2 o" d="M86 54 L102 51.7 L106 40 L90 42.3 Z"/>' +
    '<path class="handle" d="M106 6 L80 44"/>' +
    '<path class="mt o" d="M68 44 L84 39 L90 52 L75 57 Z"/>' +
    '<path class="dl" d="M72 51 L87 46"/>',
  dripEdge:
    '<path class="rf o" d="M-4 -4 L124 -4 L124 44 L-4 52 Z"/>' +
    '<path class="rl" d="M-4 12 L124 4 M-4 28 L124 20 M-4 44 L124 36 M20 -4 v14.5 M50 -4 v12.6 M80 -4 v10.7 M110 -4 v8.8 M35 9.6 v16 M65 7.8 v16 M95 5.9 v16 M20 26.5 v16 M50 24.6 v16 M80 22.7 v16 M110 20.8 v16"/>' +
    '<path class="hi o" d="M-4 52 L124 44 L124 54 L-4 62 Z"/>' +
    '<path class="wh o" d="M-4 62 L124 54 L124 65 L-4 73 Z"/>' +
    '<path class="wall" d="M-4 73 L124 65 L124 94 L-4 94 Z"/>' +
    '<path class="sl" d="M-4 84 L124 76 M-4 95 L124 87"/>',
  valley:
    '<path class="rf o" d="M-4 -4 L54 -4 L50 94 L-4 94 Z"/>' +
    '<path class="rf o" d="M66 -4 L124 -4 L124 94 L70 94 Z"/>' +
    '<path class="rl" d="M-4 10 L53 24 M-4 30 L52.2 44 M-4 50 L51.4 64 M-4 70 L50.6 84 M124 10 L67 24 M124 30 L67.8 44 M124 50 L68.6 64 M124 70 L69.4 84"/>' +
    '<path class="hi o" d="M54 -4 L66 -4 L71 94 L49 94 Z"/>' +
    '<path class="dl" d="M60 -4 L60 94"/>',
  house:
    '<path class="gnd" d="M0 87 H120"/>' +
    '<rect class="wall o" x="24" y="44" width="72" height="43"/>' +
    '<path class="rf o" d="M14 46 L60 14 L106 46 Z"/>' +
    '<path class="rl" d="M24 39 H96 M34 32 H86 M44 25 H76"/>' +
    '<rect class="dk2 o" x="54" y="62" width="12" height="25"/>' +
    '<rect class="gl o" x="32" y="56" width="14" height="12"/><rect class="gl o" x="74" y="56" width="14" height="12"/>',
};

/** The drawing's markup for an item, by its name (static, from this file). */
export const drawingFor = (name: string) => DRAWINGS[pictureFor(name)];
