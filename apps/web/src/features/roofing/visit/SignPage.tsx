/**
 * Signing together on the iPad (/roofing/:id/sign): the estimate on the business's own template (the
 * same page that prints and that the homeowner's link shows), their name and signature, and the
 * salesperson's signature for the business, saved from before or drawn now and kept for next time.
 * Each signature lands on its line on the page as it's drawn. Signing approves the estimate.
 */
import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useBlocker, useNavigate, useParams } from "react-router-dom";
import { Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api";
import { dateIn, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { documentCompany, quoteDocument, useLetterhead, useMySignature, useQuoteTemplate } from "../../documents/data";
import { DocumentSheet } from "../../documents/EstimateDocument";
import type { TakeoffRow } from "../../paving/data";
import { useEstimateQuote } from "../estimate/data";
import { firstName, money } from "../estimate/rows";
import { isEditableQuote, type EstimateQuote } from "../estimate/types";
import { isSignedQuote, signingKey, useCanSell, useSignEstimate, useVisitDetails, visitPath } from "./data";
import { roofFacts, signBlocker } from "./price";
import { Pad, VisitClosed, VisitError, VisitFrame, VisitLoading, VisitNoAccess } from "./VisitFrame";
import styles from "./visit.module.css";

export function RoofSignPage() {
  const { id = "" } = useParams();
  const canSell = useCanSell();
  const estimate = useEstimateQuote(canSell ? id : null);
  // While it's being signed here, the estimate turns signed before this screen moves on.
  const signing = useIsMutating({ mutationKey: signingKey(id) }) > 0;

  if (!canSell) return <VisitNoAccess />;
  // A refresh that fails while the estimate is showing keeps it on screen (with a toast): nothing
  // drawn or typed here is lost to a moment without signal.
  if (!estimate.data) return estimate.error ? <VisitError error={estimate.error} onRetry={() => void estimate.refetch()} /> : <VisitLoading kind="sign" />;
  const { quote, takeoff } = estimate.data;
  if (isSignedQuote(quote) && !signing) return <Navigate to={visitPath(quote.id, "signed")} replace />;
  if (!isSignedQuote(quote) && !isEditableQuote(quote)) return <VisitClosed quote={quote} />;
  if (!quote.lines.length) return <Navigate to={visitPath(quote.id, "visit")} replace />;
  return <SignScreen quote={quote} takeoff={takeoff} />;
}

function SignScreen({ quote, takeoff }: { quote: EstimateQuote; takeoff: TakeoffRow | null }) {
  const session = useSession();
  const navigate = useNavigate();
  const tz = session.company.timezone;
  const details = useVisitDetails(quote.id);
  // The template it's signed on; once signed (before this screen moves on), the one saved with it.
  const { template, isPending: templatePending } = useQuoteTemplate(quote);
  const letterhead = useLetterhead();
  const mine = useMySignature();
  const sign = useSignEstimate(quote.id);
  const panel = useRef<HTMLElement>(null);
  const id = useId();

  const letter = letterhead.data ?? documentCompany(session.company);
  const company = letter.name;
  const first = firstName(quote.client?.display_name);
  const myName = session.profile.full_name?.trim() || session.profile.email || "";
  const myFirst = firstName(myName);
  const email = quote.client?.email?.trim() || null;
  const canEmail = Boolean(email) && session.config.features.email;

  const [name, setName] = useState(quote.client?.display_name ?? "");
  const [signature, setSignature] = useState<string | null>(null);
  // The salesperson's signature for the business: their saved one, unless they sign again here.
  const [redraw, setRedraw] = useState(false);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [saveMine, setSaveMine] = useState(true);
  const [emailCopy, setEmailCopy] = useState(canEmail);
  const [signedAt] = useState(() => new Date().toISOString());

  const saved = mine.data ?? null;
  const drawing = !saved || redraw;
  // Drawn now, else the saved one (the server uses it when nothing new is drawn).
  const companyImage = (drawing ? drawn : null) ?? saved;
  const companyRow = template.company_signs || Boolean(saved);
  // What's still missing before signing, as the button says it.
  const missing = mine.isPending
    ? "Getting your signature…"
    : signBlocker({ name, signature, companyNeeded: template.company_signs, companySignature: companyImage, company });

  const data = useMemo(
    () =>
      quoteDocument(
        {
          ...quote,
          message: details.data?.message ?? null,
          valid_until: details.data?.valid_until ?? null,
          deposit_amount: details.data?.deposit_amount ?? 0,
          sent_at: details.data?.sent_at ?? null,
          created_at: details.data?.created_at ?? null,
          approval: null,
        },
        quote.lines,
        {
          // Dated as the homeowner's link dates it: the day it was sent, where the business is.
          date: details.data?.sent_at ? dateIn(details.data.sent_at, tz) : todayIn(tz),
          facts: roofFacts(details.data?.packageName, takeoff),
          signatures: {
            customer: signature ? { name: name.trim(), image: signature, date: signedAt } : null,
            company: companyImage ? { name: myName, image: companyImage, date: signedAt } : null,
          },
        },
      ),
    [quote, details.data, tz, takeoff, signature, name, signedAt, companyImage, myName],
  );
  const docReady = !templatePending && !details.isPending;

  const alreadySigned = sign.error instanceof ApiError && sign.error.status === 409 && /already signed/i.test(sign.error.message);
  // A signature drawn and not sent yet isn't lost by going back (the link, the browser's back, a
  // swipe) or reloading by mistake. Signing itself moves on without asking.
  const dirty = Boolean(signature || drawn) && !sign.isPending && !sign.isSuccess && !alreadySigned;
  const leaving = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const leaveText = `The signature${signature && drawn ? "s" : ""} drawn here will be cleared, and ${first || "the homeowner"} will sign again after.`;
  const leaveTextNow = useRef(leaveText);
  leaveTextNow.current = leaveText;
  useEffect(() => {
    if (leaving.state !== "blocked") return;
    confirm({ title: "Leave without signing?", body: leaveTextNow.current, confirmLabel: "Leave", cancelLabel: "Stay here" }).then((ok) => (ok ? leaving.proceed() : leaving.reset()));
  }, [leaving]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const submit = () => {
    if (missing || sign.isPending || !signature) return;
    const fresh = drawing && drawn ? drawn : undefined;
    sign.mutate(
      { name: name.trim(), signature, company_signature: fresh, save_signature: Boolean(fresh && saveMine), email_copy: canEmail && emailCopy },
      { onSuccess: (result) => navigate(visitPath(quote.id, "signed"), { replace: true, state: { emailed: result.emailed, email_reason: result.email_reason ?? null } }) },
    );
  };

  return (
    <VisitFrame
      title="Sign together"
      subtitle={`Hand the iPad to ${first || "the homeowner"}`}
      back={{ to: visitPath(quote.id, "visit"), label: "Back to the price" }}
      me={false}
      pageTitle={`Sign together · ${quote.title}`}
    >
      <div className={styles.sign}>
        <div className={styles.docArea}>
          <div className={styles.docHint}>
            <span>{first ? `${first}, look it over, then sign below.` : "Look it over, then sign below."}</span>
            <button type="button" className={`btn ${styles.touch}`} onClick={() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              <Icon name="pen" size={17} />
              Sign now
            </button>
          </div>
          {docReady ? <DocumentSheet template={template} company={letter} data={data} /> : <div className={styles.docSkeleton} role="status" aria-label="Loading the estimate" />}
        </div>

        <aside ref={panel} className={styles.signPanel} aria-label="Signatures">
          <div className={styles.signScroll}>
            <div className={styles.signIntro}>
              <h1>{first ? `${first}, look it over and sign` : "Look it over and sign"}</h1>
              <p>
                Signing agrees to the work and price <span className={styles.wideOnly}>on the left</span>
                <span className={styles.narrowOnly}>above</span>, <strong>{money(quote.total)}</strong>
                {template.terms.trim() ? ", and the terms." : "."}
              </p>
            </div>

            <div className={styles.field}>
              <label htmlFor={`${id}-name`}>Your name</label>
              <input
                id={`${id}-name`}
                className={`input ${styles.bigInput}`}
                value={name}
                maxLength={120}
                autoComplete="off"
                autoCapitalize="words"
                enterKeyHint="done"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            </div>

            <div className={styles.padBlock}>
              <span className={styles.padLabel}>Your signature</span>
              <Pad value={signature} onChange={setSignature} label="Sign here with your finger" height={170} />
            </div>

            {companyRow &&
              (mine.isPending ? (
                <Skeleton height={68} radius={12} />
              ) : drawing ? (
                <div className={styles.padBlock}>
                  <span className={styles.padLabel}>{myFirst ? `${myFirst}, sign for ${company}` : `Sign for ${company}`}</span>
                  <Pad value={drawn} onChange={setDrawn} label={`Sign for ${company}`} height={120} />
                  <label className={styles.check}>
                    <input type="checkbox" checked={saveMine} onChange={(e) => setSaveMine(e.target.checked)} />
                    Save my signature for next time
                  </label>
                  {saved && (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => {
                        setRedraw(false);
                        setDrawn(null);
                      }}
                    >
                      Use my saved signature
                    </button>
                  )}
                </div>
              ) : (
                <div className={styles.companyRow}>
                  <img src={saved!} alt={`${myName || "Your"} signature`} className={styles.companyImage} />
                  <span className={styles.companyText}>
                    <strong>{myName}</strong>
                    <span>Signed for {company}</span>
                  </span>
                  <button type="button" className={styles.textButton} onClick={() => setRedraw(true)}>Sign again</button>
                </div>
              ))}

            {canEmail ? (
              <label className={styles.check}>
                <input type="checkbox" checked={emailCopy} onChange={(e) => setEmailCopy(e.target.checked)} />
                <span>Email {first || "them"} a copy at <strong className={styles.breakable}>{email}</strong></span>
              </label>
            ) : (
              <p className={styles.smallNote}>
                {email ? "Email isn't set up yet, so print or text a copy after signing." : `There's no email address for ${first || "this client"}, so print or text a copy after signing.`}
              </p>
            )}
          </div>

          <div className={styles.signFoot}>
            <FormError error={sign.error} />
            {alreadySigned && (
              <Link className={`btn ${styles.touch}`} to={visitPath(quote.id, "signed")} replace>
                See the signed estimate
              </Link>
            )}
            <button type="button" className={`btn btn-primary ${styles.bigButton}`} disabled={Boolean(missing) || sign.isPending} aria-busy={sign.isPending || undefined} onClick={submit}>
              {sign.isPending ? <Spinner size={18} /> : !missing && <Icon name="pen" size={19} />}
              {sign.isPending ? "Signing…" : (missing ?? "Sign and finish")}
            </button>
          </div>
        </aside>
      </div>
    </VisitFrame>
  );
}
