/**
 * What a price list item looks like, filling its box: the business's own picture of it (Settings →
 * Price list), else a drawing of it by its name (pictures.ts). On the iPad's site visit tiles
 * (VisitPicks) and beside each item in the price list.
 */
import { servicePictureSrc } from "@crewtavo/core/presets";
import { useState } from "react";
import { drawingFor } from "./pictures";
import styles from "./picks.module.css";

export function ServicePicture({ name, picture, className }: { name: string; picture?: string | null; className?: string }) {
  // A picture that didn't load (no signal, or removed meanwhile) shows the drawing instead.
  const [failed, setFailed] = useState<string | null>(null);
  if (picture && failed !== picture) {
    return <img className={[styles.photo, className].filter(Boolean).join(" ")} src={servicePictureSrc(picture)} alt="" decoding="async" draggable={false} onError={() => setFailed(picture)} />;
  }
  return (
    <svg
      className={[styles.picture, className].filter(Boolean).join(" ")}
      viewBox="0 0 120 90"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      // Static drawings from pictures.ts, never anything typed in.
      dangerouslySetInnerHTML={{ __html: drawingFor(name) }}
    />
  );
}
