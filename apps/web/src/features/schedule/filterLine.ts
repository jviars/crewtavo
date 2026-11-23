import { t } from "@/lib/i18n";

/**
 * The line over the board while a filter is on, "Showing Luis Ortega's visits · Show everyone", or
 * null with none on. `person` is "" for everyone, "none" for visits nobody is on yet, or someone's
 * id (`me` for your own); `crew` is the picked crew's name.
 */
export function filterLine(person: string, me: string, name: string, crew?: string): { text: string; clear: string } | null {
  if (!person && !crew) return null;
  const clear = !crew ? t("Show everyone") : !person ? t("Show all crews") : t("Show all visits");
  if (!person) return { text: t("Showing {crew}'s visits", { crew }), clear };
  if (person === "none") return { text: crew ? t("Showing {crew}'s visits with nobody assigned", { crew }) : t("Showing visits with nobody assigned"), clear };
  if (person === me) return { text: crew ? t("Showing your visits on {crew}", { crew }) : t("Showing your visits"), clear };
  return { text: crew ? t("Showing {name}'s visits on {crew}", { name, crew }) : t("Showing {name}'s visits", { name }), clear };
}
