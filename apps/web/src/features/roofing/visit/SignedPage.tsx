/**
 * Signed (/roofing/:id/signed): the estimate is signed and saved on the project with both
 * signatures. From here the salesperson prints the homeowner a copy (AirPrint, from the iPad), sees
 * that the copy was emailed (or emails it), or texts them a link: email and texting only when this
 * Crewtavo can send them (config features), never as a button that can't. It reads everything from the
 * estimate itself, so it works after a reload too. The copy prints the option they chose and the
 * contract as they signed it (with their initials), kept with the signature.
 */
import { useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { Spinner } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/lib/session";
import { documentCompany, quoteDate, quoteDocument, readApproval, useLetterhead, useQuoteTemplate } from "../../documents/data";
import { PrintableDocument, printDocument } from "../../documents/EstimateDocument";
import { useEstimateQuote } from "../estimate/data";
import { firstName } from "../estimate/rows";
import { isEditableQuote, type EstimateQuote } from "../estimate/types";
import { isSignedQuote, linesWithOptions, signingOutcome, useCanSell, useSendCopy, useSignedCopies, useVisitDetails, visitPath } from "./data";
import { signedSentence } from "./price";
import { VisitError, VisitFrame, VisitLoading, VisitNoAccess, whoAndWhere } from "./VisitFrame";
import styles from "./visit.module.css";

export function RoofSignedPage() {
  const { id = "" } = useParams();
  const canSell = useCanSell();
  const estimate = useEstimateQuote(canSell ? id : null);

  if (!canSell) return <VisitNoAccess />;
  // A refresh that fails while the estimate is showing keeps it on screen (with a toast): nothing
  // drawn or typed here is lost to a moment without signal.
  if (!estimate.data) return estimate.error ? <VisitError error={estimate.error} onRetry={() => void estimate.refetch()} /> : <VisitLoading kind="signed" />;
  const { quote } = estimate.data;
  if (!isSignedQuote(quote)) {
    // Just signed: the estimate may still be on its way.
    if (estimate.isFetching) return <VisitLoading kind="signed" />;
    return <Navigate to={isEditableQuote(quote) ? visitPath(quote.id, "visit") : `/roofing/${quote.id}`} replace />;
  }
  return <SignedScreen quote={quote} />;
}

function SignedScreen({ quote }: { quote: EstimateQuote }) {
  const session = useSession();
  const location = useLocation();
  const tz = session.company.timezone;
  const features = session.config.features;
  const outcome = signingOutcome(quote.id, location.state);
  const details = useVisitDetails(quote.id);
  const copies = useSignedCopies(quote.id, quote.approved_at);
  // The template it was signed on, saved with the signatures.
  const { template, isPending: templatePending } = useQuoteTemplate(quote);
  const letterhead = useLetterhead();
  const emailCopy = useSendCopy(quote.id, "email");
  const textCopy = useSendCopy(quote.id, "sms");
  const [printing, setPrinting] = useState(false);

  const letter = letterhead.data ?? documentCompany(session.company);
  const approval = readApproval(quote.approval);
  const amount = typeof quote.approval?.total === "number" ? quote.approval.total : quote.total;
  const first = firstName(quote.client?.display_name);
  const them = first || "them";
  const myFirst = firstName(session.profile.full_name);
  const email = quote.client?.email?.trim() || null;
  const phone = quote.client?.phone?.trim() || null;
  const bothSigned = Boolean(approval?.signature && approval.company);

  const heading = approval?.method === "in_person" ? `Signed. Nice work${myFirst ? `, ${myFirst}` : ""}.` : approval?.method === "manual" ? "Approved." : "Signed.";
  const sentence = signedSentence({
    client: quote.client?.display_name ?? "",
    amount,
    signedAt: approval?.signed_at ?? quote.approved_at,
    timeZone: tz,
    method: approval?.method ?? null,
    companySigner: approval?.company?.name || null,
    byMe: approval?.company?.user_id === session.userId,
  });

  // The signed estimate, as it prints: hidden on screen, and what the iPad prints. It prints the
  // option it was signed for and the contract kept with it (build.ts quoteDocument and signedTemplate),
  // so it waits for the details that say which option each line is on.
  const docReady = !templatePending && Boolean(details.data);
  // A moment without signal: tapping Print loads them again.
  const copyFailed = !details.data && Boolean(details.error);
  const data = quoteDocument(
    {
      ...quote,
      option_id: details.data?.optionId ?? null,
      message: details.data?.message ?? null,
      valid_until: details.data?.valid_until ?? null,
      deposit_amount: details.data?.deposit_amount ?? 0,
      sent_at: details.data?.sent_at ?? null,
      created_at: details.data?.created_at ?? null,
    },
    linesWithOptions(quote.lines, details.data?.lineOptions),
    {
      // The day it was sent, else the day it was made, as its {Date} says it.
      date: quoteDate({ sent_at: details.data?.sent_at, created_at: details.data?.created_at }, tz),
      // An approval kept from before the option was kept with it: the option shown.
      choice: details.data?.options.find((o) => o.id === details.data?.optionId) ?? null,
    },
  );
  const print = async () => {
    setPrinting(true);
    try {
      await printDocument();
    } finally {
      setPrinting(false);
    }
  };

  const emailed = Boolean(emailCopy.data?.sent || copies.data?.email || outcome?.emailed);
  const emailProblem = emailCopy.error
    ? errorMessage(emailCopy.error)
    : emailCopy.data && !emailCopy.data.sent
      ? (emailCopy.data.reason ?? "It didn't go out. Try again.")
      : !emailCopy.data && outcome?.email_reason
        ? `It didn't go out when you signed. ${outcome.email_reason}`
        : null;
  const texted = Boolean(textCopy.data?.sent || copies.data?.sms);
  const textProblem = textCopy.error ? errorMessage(textCopy.error) : textCopy.data && !textCopy.data.sent ? (textCopy.data.reason ?? "It didn't go out. Try again.") : null;

  return (
    <VisitFrame title={quote.title} subtitle={whoAndWhere(quote)} pageTitle={`Signed · ${quote.title}`}>
      <main className={styles.done}>
        <div className={styles.doneHead}>
          <span className={styles.bigCheck} aria-hidden="true"><Icon name="check" size={38} strokeWidth={4.5} /></span>
          <h1>{heading}</h1>
          <p>
            {sentence.lead} <strong>{sentence.amount}</strong>
            {sentence.rest}
          </p>
        </div>

        <div className={styles.actions}>
          <ActionCard
            icon="printer"
            busy={printing || (copyFailed && details.isFetching)}
            disabled={!docReady && !copyFailed}
            title={printing ? "Getting it ready…" : "Print a copy"}
            text={`For ${them} to keep. Prints to any AirPrint printer nearby.`}
            problem={copyFailed ? "The copy didn't load. Check the connection, then tap to try again." : null}
            onClick={() => (copyFailed ? void details.refetch() : void print())}
          />
          {features.email &&
            (emailed ? (
              <DoneCard icon="mail" title={`Emailed to ${them}`} text={`A copy with ${bothSigned ? "both signatures" : "the signature"} went to ${email ?? "their email"}.`} />
            ) : (
              <ActionCard
                icon="mail"
                busy={emailCopy.isPending}
                disabled={!email}
                title={emailCopy.isPending ? "Sending…" : `Email ${them} a copy`}
                text={!email ? `There's no email address for ${them}. Add one on their client page.` : `To ${email}.`}
                problem={emailProblem}
                onClick={() => emailCopy.mutate()}
              />
            ))}
          {features.sms &&
            (texted ? (
              <DoneCard icon="messages" title={`Texted ${them} a link`} text={`It went to ${phone ?? "their phone"}.`} />
            ) : (
              <ActionCard
                icon="messages"
                busy={textCopy.isPending}
                disabled={!phone}
                title={textCopy.isPending ? "Sending…" : `Text ${them} a link`}
                text={!phone ? `There's no phone number for ${them}. Add one on their client page.` : `To ${phone}. ${first || "They"} can open it any time.`}
                problem={textProblem}
                onClick={() => textCopy.mutate()}
              />
            ))}
        </div>

        <div className={styles.officeKnows}>
          <span className={styles.officeIcon} aria-hidden="true"><Icon name="bell" size={20} /></span>
          <p><strong>The office knows.</strong> They got a note, and the project moved to Schedule.</p>
        </div>

        <div className={styles.doneButtons}>
          <Link className={`btn ${styles.doneButton}`} to={`/roofing/${quote.id}`}>Open the project</Link>
          <Link className={`btn btn-dark ${styles.doneButton}`} to="/roofing">
            Back to Roofing
            <Icon name="arrowRight" size={20} strokeWidth={2} />
          </Link>
        </div>
      </main>
      {docReady && <PrintableDocument template={template} company={letter} data={data} />}
    </VisitFrame>
  );
}

function ActionCard({ icon, title, text, problem, busy, disabled, onClick }: { icon: IconName; title: string; text: ReactNode; problem?: string | null; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <div className={styles.actCell}>
      <button type="button" className={styles.act} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>
        <span className={styles.actIcon}>{busy ? <Spinner size={24} /> : <Icon name={icon} size={24} />}</span>
        <strong className={styles.actTitle}>{title}</strong>
        <span className={styles.actText}>{text}</span>
      </button>
      {problem && <p className={styles.actProblem} role="alert">{problem}</p>}
    </div>
  );
}

function DoneCard({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className={styles.actCell}>
      <div className={styles.act} data-done="" role="status">
        <span className={styles.actIcon}><Icon name={icon} size={24} /></span>
        <strong className={styles.actTitle}>
          <Icon name="check" size={16} strokeWidth={2} />
          {title}
        </strong>
        <span className={styles.actText}>{text}</span>
      </div>
    </div>
  );
}
