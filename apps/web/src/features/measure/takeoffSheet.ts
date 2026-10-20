/**
 * The takeoff sheet: the saved picture of a drawing, made into something a client or a crew can
 * read off paper. The map gets a graphic scale (a bar marked in feet, which stays true however
 * the sheet is printed or zoomed) and a north arrow, and under it a title block (business, job,
 * address, date, imagery credit) and a legend of what was measured, with each item's quantity.
 */

export interface SheetLegendRow {
  color: string;
  label: string;
  value: string;
  /** How the swatch is drawn: a filled square, a line or a dot. */
  shape: "area" | "line" | "count";
}

export interface SheetInfo {
  business: string;
  title: string;
  place?: string | null;
  date: string;
  credit: string;
  legend: SheetLegendRow[];
}

/** Bar lengths a scale can show, in feet: round numbers people read at a glance. */
const NICE_FT = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

/** The graphic scale's length in feet for a map at this many feet per pixel, about `target` pixels long. */
export function scaleLength(ftPerPixel: number, target: number): number {
  const want = ftPerPixel * target;
  return NICE_FT.reduce((best, ft) => (Math.abs(ft - want) < Math.abs(best - want) ? ft : best), NICE_FT[0]);
}

/** Feet per pixel of a Web Mercator map at this zoom and latitude, for 512 px tiles (MapLibre's). */
export function feetPerPixel(zoom: number, lat: number, pixelRatio = 1): number {
  const metersPerCssPixel = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
  return (metersPerCssPixel * 3.280_839_9) / pixelRatio;
}

/** The map with its scale and north arrow, and the title block and legend under it. */
export function drawSheet(map: HTMLCanvasElement, ftPerPixel: number, info: SheetInfo): HTMLCanvasElement {
  const width = map.width;
  const u = width / 1000; // one unit: sizes below read as if the sheet were 1000 px wide
  const font = (size: number, weight = 400) => `${weight} ${Math.round(size * u)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const columns = info.legend.length > 6 ? 2 : 1;
  const rows = Math.ceil(info.legend.length / columns);
  const footer = Math.round(Math.max(128, 46 + rows * 24) * u);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = map.height + footer;
  const ctx = canvas.getContext("2d");
  if (!ctx) return map;
  ctx.drawImage(map, 0, 0);

  // ----- Graphic scale, bottom left of the map -------------------------------------------------
  const lengthFt = scaleLength(ftPerPixel, 180 * u);
  const barPx = lengthFt / ftPerPixel;
  const pad = 14 * u;
  const boxW = barPx + 2 * pad + 10 * u; // room for "100 ft" hanging past the bar's end
  const boxH = 56 * u;
  const bx = 16 * u;
  const by = map.height - boxH - 16 * u;
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  roundRect(ctx, bx, by, boxW, boxH, 8 * u);
  ctx.fill();
  const x0 = bx + pad;
  const barY = by + 30 * u;
  const barH = 8 * u;
  const segments = 4;
  for (let i = 0; i < segments; i++) {
    ctx.fillStyle = i % 2 ? "#ffffff" : "#111827";
    ctx.fillRect(x0 + (barPx * i) / segments, barY, barPx / segments, barH);
  }
  ctx.strokeStyle = "#111827";
  ctx.lineWidth = Math.max(1, 1.2 * u);
  ctx.strokeRect(x0, barY, barPx, barH);
  ctx.fillStyle = "#111827";
  ctx.font = font(12, 600);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  for (const [i, value] of [[0, 0], [segments / 2, lengthFt / 2], [segments, lengthFt]] as const) {
    ctx.fillText(i === segments ? `${value} ft` : String(value), x0 + (barPx * i) / segments, barY - 6 * u);
  }
  ctx.font = font(10);
  ctx.textAlign = "left";
  ctx.fillText("Graphic scale", x0, barY + barH + 14 * u);

  // ----- North arrow, top right of the map (the measuring map never turns) ---------------------
  const r = 22 * u;
  const cx = width - r - 16 * u;
  const cy = r + 16 * u;
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111827";
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.78);
  ctx.lineTo(cx + r * 0.36, cy + r * 0.3);
  ctx.lineTo(cx, cy + r * 0.12);
  ctx.lineTo(cx - r * 0.36, cy + r * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.font = font(11, 700);
  ctx.textAlign = "center";
  ctx.fillText("N", cx, cy + r * 0.78);

  // ----- Title block and legend under the map --------------------------------------------------
  const top = map.height;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, top, width, footer);
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, top, width, Math.max(1, 2 * u));
  const left = 24 * u;
  const split = info.legend.length ? width * (columns === 2 ? 0.42 : 0.55) : width;
  ctx.textAlign = "left";
  let y = top + 32 * u;
  ctx.font = font(18, 700);
  ctx.fillText(clip(ctx, info.title, split - left - 24 * u), left, y);
  y += 22 * u;
  ctx.font = font(13);
  ctx.fillStyle = "#374151";
  if (info.place) {
    ctx.fillText(clip(ctx, info.place, split - left - 24 * u), left, y);
    y += 19 * u;
  }
  ctx.fillText(clip(ctx, `${info.business} · ${info.date}`, split - left - 24 * u), left, y);
  ctx.font = font(10);
  ctx.fillStyle = "#6b7280";
  ctx.fillText(clip(ctx, info.credit, split - left - 24 * u), left, top + footer - 30 * u);
  ctx.fillText("Measured from aerial imagery. Check on site before ordering.", left, top + footer - 14 * u);

  if (info.legend.length) {
    const colW = (width - split - 24 * u) / columns;
    ctx.font = font(11, 700);
    ctx.fillStyle = "#6b7280";
    ctx.fillText("TAKEOFF", split, top + 24 * u);
    info.legend.forEach((row, i) => {
      const col = Math.floor(i / rows);
      const x = split + col * colW;
      const ry = top + 46 * u + (i % rows) * 24 * u;
      swatch(ctx, row, x, ry - 10 * u, 14 * u);
      ctx.fillStyle = "#111827";
      ctx.font = font(13);
      ctx.textAlign = "left";
      const valueWidth = ctx.measureText(row.value).width;
      ctx.fillText(clip(ctx, row.label, colW - valueWidth - 44 * u), x + 22 * u, ry + 2 * u);
      ctx.font = font(13, 700);
      ctx.textAlign = "right";
      ctx.fillText(row.value, x + colW - 16 * u, ry + 2 * u);
      ctx.textAlign = "left";
    });
  }
  return canvas;
}

function swatch(ctx: CanvasRenderingContext2D, row: SheetLegendRow, x: number, y: number, size: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(17, 24, 39, 0.55)";
  ctx.lineWidth = Math.max(1, size / 12);
  if (row.shape === "area") {
    ctx.fillStyle = row.color;
    ctx.fillRect(x, y, size, size);
    ctx.strokeRect(x, y, size, size);
  } else if (row.shape === "line") {
    ctx.strokeStyle = "rgba(17, 24, 39, 0.55)";
    ctx.lineWidth = size / 2.4;
    ctx.beginPath();
    ctx.moveTo(x, y + size / 2);
    ctx.lineTo(x + size, y + size / 2);
    ctx.stroke();
    ctx.strokeStyle = row.color;
    ctx.lineWidth = size / 3.6;
    ctx.stroke();
  } else {
    ctx.fillStyle = row.color;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Text cut to fit a width, with an ellipsis. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}
