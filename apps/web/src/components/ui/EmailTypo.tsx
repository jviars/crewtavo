/**
 * "Did you mean jo@gmail.com?" under an email box, once someone leaves it with what looks like a slip
 * on a common mailbox (core emailTypo). A quote or invoice sent to a mistyped address bounces later,
 * where nobody sees it, so it's asked here, with the fix one press away. Never while typing: "gmail.co"
 * is on its way to ".com".
 *
 *   const typo = useEmailTypo(email, setEmail);
 *   <Field label="Email" hint={typo.hint}><input … onBlur={typo.onBlur} /></Field>
 */
import { emailTypo } from "@crewtavo/core/email";
import { useState, type FocusEvent } from "react";
import { T } from "@/lib/i18n";

export function useEmailTypo(email: string, fix: (email: string) => void) {
  // The address as it was left: a suggestion is about that, and goes once it's changed.
  const [left, setLeft] = useState<string | null>(null);
  const suggestion = left !== null && left === email ? emailTypo(email) : null;
  return {
    onBlur: (e: FocusEvent<HTMLInputElement>) => setLeft(e.target.value),
    hint: suggestion ? (
      <span className="email-typo" role="status">
        <T text="Did you mean <fix>{email}</fix>?" email={suggestion} fix={(s) => <button type="button" className="link-btn" onClick={() => fix(suggestion)}>{s}</button>} />
      </span>
    ) : null,
  };
}
