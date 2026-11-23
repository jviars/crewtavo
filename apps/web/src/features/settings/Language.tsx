/**
 * The language someone uses Crewtavo in (profiles.locale): chosen in Settings → Profile, or by
 * answering My day's question when their phone speaks Spanish. Their screens for the day, chat,
 * guides and the notifications they get are in it; office screens stay in English for now.
 */
import { useMutation } from "@tanstack/react-query";
import { FormError } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { getLocale, LOCALE_NAMES, switchLocale, t, type Locale } from "@/lib/i18n";
import { useSession, type Session } from "@/lib/session";

/** Saves their choice, then reloads into it when the app is in the other language. */
export async function saveLanguage(session: Session, locale: Locale) {
  await api.patch("/me", { locale });
  // Saved with them for next time (also the copy kept for no signal), before the reload.
  await session.refresh();
  switchLocale(locale);
}

export function LanguageCard() {
  const session = useSession();
  const current = getLocale();
  const save = useMutation({ meta: { inline: true }, mutationFn: (locale: Locale) => saveLanguage(session, locale) });
  return (
    <div className="set-item">
      <span className="set-item-label" id="language-title">{t("Language")}</span>
      <div className="segmented" role="group" aria-labelledby="language-title">
        {(["en", "es"] as const).map((locale) => (
          <button key={locale} type="button" lang={locale} aria-pressed={current === locale} disabled={save.isPending} onClick={() => save.mutate(locale)}>
            {LOCALE_NAMES[locale]}
          </button>
        ))}
      </div>
      <span className="hint">{t("My day, visits, the clock, chat, guides and your notifications. Office screens stay in English for now.")}</span>
      <FormError error={save.error} />
    </div>
  );
}
