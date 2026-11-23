/**
 * My day asks once, in both languages, whether to use Crewtavo in Spanish: for someone who hasn't
 * chosen a language yet whose phone is set to Spanish. (Someone who picks a language on the sign-in
 * page has it saved with them as they sign in, and isn't asked.) Either answer is saved with them
 * (profiles.locale), so it isn't asked again on any phone; Settings → Profile → Language changes it
 * later. A server older than the language choice sends no locale at all, and then nothing is asked.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { askedHere, deviceLocale, noteAsked, phoneSpeaksSpanish, type Locale } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { saveLanguage } from "../settings/Language";

export function SpanishOffer() {
  const session = useSession();
  // Noted for this person only, and taken off the phone when they sign out: the next person is asked for themselves.
  const [hidden, setHidden] = useState(() => askedHere(session.userId));
  const answer = useMutation({
    meta: { inline: true },
    mutationFn: async (locale: Locale) => {
      noteAsked(session.userId);
      await saveLanguage(session, locale);
    },
    onSuccess: () => setHidden(true),
  });
  if (hidden || session.profile.locale !== null || !(phoneSpeaksSpanish() || deviceLocale() === "es")) return null;
  // Asked in Spanish, with the English underneath for whoever reads the screen with them.
  return (
    <section className="callout callout-info field-ask" aria-labelledby="spanish-offer">
      <Icon name="globe" size={16} />
      <div className="grow">
        {/* i18n-ignore: asked in both languages whatever the app is in */}
        <strong id="spanish-offer" lang="es">¿Usar Crewtavo en español?</strong>
        {/* i18n-ignore */}
        <div lang="en">Use Crewtavo in Spanish? You can change it later in Settings → Profile.</div>
        <FormError error={answer.error} />
        <div className="field-ask-acts">
          {/* i18n-ignore: both quiet, Sí first: My day's one green button is the visit's next step. */}
          <Button lang="es" loading={answer.isPending && answer.variables === "es"} onClick={() => answer.mutate("es")}>Sí, en español</Button>
          {/* i18n-ignore */}
          <Button lang="en" loading={answer.isPending && answer.variables === "en"} onClick={() => answer.mutate("en")}>No, keep English</Button>
        </div>
      </div>
    </section>
  );
}
