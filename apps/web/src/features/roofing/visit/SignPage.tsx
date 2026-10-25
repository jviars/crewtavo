/**
 * Signing together on the iPad (/roofing/:id/sign): the estimate on the business's own template (the
 * same page that prints and that the homeowner's link shows) for the option they chose on the visit
 * page, with its contract; their name, their initials (drawn once, then added to each section that
 * asks) and signature, and the salesperson's signature for the business, saved from before or drawn
 * now and kept for next time. Each signature and initial lands on the page as it's drawn. Signing
 * approves the estimate, only while it's still the option and the price on the paper.
 */
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useBlocker, useNavigate, useParams } from "react-router-dom";
import { Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  awaitingInitials,
  choiceLabel,
  contractTemplate,
  documentCompany,
  hasContract,
  initialSection,
  optionTiers,
  quoteDate,
  quoteDocument,
  smallInitials,
  stillInitialed,
  useLetterhead,
  useMySignature,
  useQuoteContract,
  useQuoteTemplate,
  withInitials,
  type InitialedSections,
} from "../../documents/data";
import { DocumentSheet } from "../../documents/EstimateDocument";
import type { DocumentSection } from "../../documents/types";
import type { TakeoffRow } from "../../paving/data";
import { useEstimateQuote } from "../estimate/data";
import { firstName, money } from "../estimate/rows";
import { isEditableQuote, type EstimateQuote } from "../estimate/types";
import {
  checkSigningAgain,
  isSignedQuote,
  linesWithOptions,
  paperContract,
  signContractInput,
  signingKey,
  signingTotals,
  useCanSell,
  useSignEstimate,
  useVisitDetails,
  visitPath,
} from "./data";
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
  const queryClient = useQueryClient();
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
  // Their initials, drawn once, and the sections they've added them to (with the words those had then).
  const [initials, setInitials] = useState<string | null>(null);
  const [initialed, setInitialed] = useState<InitialedSections>(() => new Map());
  // The salesperson's signature for the business: their saved one, unless they sign again here.
  const [redraw, setRedraw] = useState(false);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [saveMine, setSaveMine] = useState(true);
  const [emailCopy, setEmailCopy] = useState(canEmail);
  const [signedAt] = useState(() => new Date().toISOString());
  // Loading the paper again after the server said it changed: signing waits until it's in.
  const [checking, setChecking] = useState(false);

  // The option they chose on the visit page (the one shown) is the one they sign for.
  const options = details.data?.options ?? [];
  const offers = options.length > 0;
  const lines = useMemo(() => linesWithOptions(quote.lines, details.data?.lineOptions), [quote.lines, details.data?.lineOptions]);
  const option = options.find((o) => o.id === details.data?.optionId) ?? null;
  const promo = details.data?.promo ?? null;
  const totals = signingTotals(quote, lines, option?.id ?? null, promo);
  // The tier word as the Client Hub and the signed copy say it ("Better").
  const choice = option ? { name: option.name, tier: optionTiers(options, lines, { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo }).get(option.id) ?? option.tier ?? null } : null;
  const tier = choice?.tier ?? null;

  // The contract on the paper, filled in from the same facts the server keeps with the signature, and
  // fingerprinted with the option's card as the server keeps it (its tier word as the card says it).
  const contractFor = useMemo(() => signContractInput(quote, details.data, template, option, totals.total, tier), [quote, details.data, template, option, totals.total, tier]);
  const terms = useQuoteContract(contractFor);
  const contract = terms.contract;
  const asking = contract?.sections.filter((s) => s.initials) ?? [];
  // Initials on a section whose words changed since (the terms were loaded again) come off it.
  const initialedNow = useMemo(() => stillInitialed(contract, initialed), [contract, initialed]);
  const waiting = awaitingInitials(contract, initialedNow);
  const stamped = useMemo(() => (contract ? withInitials(contract, initials ? { image: initials, date: signedAt } : null, initialedNow) : null), [contract, initials, signedAt, initialedNow]);
  // When the terms didn't load, the paper prints none rather than the template's with their fill-ins unfilled.
  const paper = useMemo(() => paperContract(stamped, Boolean(terms.error)), [stamped, terms.error]);
  // A moment without signal: the rest of the estimate didn't load, so there's no paper to sign yet.
  const detailsFailed = !details.data && Boolean(details.error);

  const saved = mine.data ?? null;
  const drawing = !saved || redraw;
  // Drawn now, else the saved one (the server uses it when nothing new is drawn).
  const companyImage = (drawing ? drawn : null) ?? saved;
  const companyRow = template.company_signs || Boolean(saved);
  // What's still missing before signing, as the button says it: the estimate, the option, the terms, the initials, then the signatures.
  const missing = checking
    ? "Checking it again…"
    : mine.isPending
      ? "Getting your signature…"
      : detailsFailed
        ? "The estimate didn't load"
        : templatePending || !details.data
          ? "Getting the estimate…"
          : offers && !option
            ? "Choose their option first"
            : terms.error
              ? "The terms didn't load"
              : !contract
                ? "Getting the terms…"
                : waiting.length
                  ? initials
                    ? `Add initials to ${waiting.length === 1 ? "1 more section" : `${waiting.length} more sections`}`
                    : "Draw your initials to finish"
                  : signBlocker({ name, signature, companyNeeded: template.company_signs, companySignature: companyImage, company });

  const data = useMemo(
    () =>
      quoteDocument(
        {
          ...quote,
          subtotal: totals.subtotal,
          discount_amount: totals.discount,
          tax_amount: totals.tax,
          total: totals.total,
          option_id: option?.id ?? null,
          message: details.data?.message ?? null,
          valid_until: details.data?.valid_until ?? null,
          deposit_amount: details.data?.deposit_amount ?? 0,
          sent_at: details.data?.sent_at ?? null,
          created_at: details.data?.created_at ?? null,
          approval: null,
        },
        lines,
        {
          // Dated as the homeowner's link dates it, and as its {Date} says it: the day it was sent, else
          // the day it was made, where the business is.
          date: quoteDate({ sent_at: details.data?.sent_at, created_at: details.data?.created_at }, tz),
          // With options, the strip says which they chose rather than the package.
          facts: roofFacts(offers ? null : details.data?.packageName, takeoff),
          signatures: {
            customer: signature ? { name: name.trim(), image: signature, date: signedAt } : null,
            company: companyImage ? { name: myName, image: companyImage, date: signedAt } : null,
          },
          optionId: option?.id ?? null,
          choice,
          contract: paper,
        },
      ),
    [quote, totals, option, details.data, lines, tz, offers, takeoff, signature, name, signedAt, companyImage, myName, choice, paper],
  );
  const docReady = !templatePending && Boolean(details.data) && paper !== null;

  const alreadySigned = sign.error instanceof ApiError && sign.error.status === 409 && /already signed/i.test(sign.error.message);
  // The option, the price or the terms changed since the paper loaded: load it again to look over.
  const changed = sign.error instanceof ApiError && sign.error.status === 409 && !alreadySigned;
  // A signature drawn and not sent yet isn't lost by going back (the link, the browser's back, a
  // swipe) or reloading by mistake. Signing itself moves on without asking.
  const dirty = Boolean(signature || drawn || initials) && !sign.isPending && !sign.isSuccess && !alreadySigned;
  const leaving = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const leaveText = `What's drawn here will be cleared, and ${first || "the homeowner"} will sign again after.`;
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

  const initialsSeq = useRef(0);
  const drawInitials = (image: string | null) => {
    const seq = ++initialsSeq.current;
    if (!image) {
      setInitials(null);
      setInitialed(new Map());
      return;
    }
    void smallInitials(image)
      .catch(() => image)
      .then((small) => seq === initialsSeq.current && setInitials(small));
  };
  const initial = (section: DocumentSection, on: boolean) => setInitialed((was) => initialSection(was, section, on));
  // The option, the price or the terms changed since the paper loaded: the estimate, its details, the
  // template and the terms again, and signing waits until they're in.
  const checkAgain = () => {
    sign.reset();
    setChecking(true);
    void checkSigningAgain(queryClient, quote.id, session.company.id).finally(() => setChecking(false));
  };

  const submit = () => {
    if (missing || sign.isPending || !signature || !contract) return;
    const fresh = drawing && drawn ? drawn : undefined;
    sign.mutate(
      {
        name: name.trim(),
        signature,
        company_signature: fresh,
        save_signature: Boolean(fresh && saveMine),
        email_copy: canEmail && emailCopy,
        ...(option ? { option_id: option.id } : {}),
        expected_total: totals.total,
        ...(contract.hash ? { sections_hash: contract.hash } : {}),
        ...(initials && asking.length ? { initials } : {}),
      },
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
          {docReady ? (
            <DocumentSheet template={contractTemplate(template, paper)} company={letter} data={data} />
          ) : detailsFailed ? (
            <div className="card">
              <ErrorState error={details.error} title="The estimate didn't load" onRetry={() => void details.refetch()} />
            </div>
          ) : (
            <div className={styles.docSkeleton} role="status" aria-label="Loading the estimate" />
          )}
        </div>

        <aside ref={panel} className={styles.signPanel} aria-label="Signatures">
          <div className={styles.signScroll}>
            <div className={styles.signIntro}>
              <h1>{first ? `${first}, look it over and sign` : "Look it over and sign"}</h1>
              <p>
                Signing agrees to {choice ? <strong>{choiceLabel(choice)}</strong> : "the work"} and the price <span className={styles.wideOnly}>on the left</span>
                <span className={styles.narrowOnly}>above</span>, <strong>{money(totals.total)}</strong>
                {hasContract(contract) ? ", and the terms." : "."}
              </p>
            </div>

            {offers && !option && (
              <div className="callout callout-warning">
                <Icon name="alert" size={18} />
                <div className="grow">
                  Choose the option {first || "they"} picked on the visit page first.{" "}
                  <Link to={visitPath(quote.id, "visit")}>Back to the price</Link>
                </div>
              </div>
            )}
            {terms.error && (
              <div className="callout callout-danger" role="alert">
                <Icon name="alert" size={18} />
                <div className="grow">The terms didn't load. Check the connection and try again.</div>
                <button type="button" className={styles.textButton} onClick={terms.refetch}>Try again</button>
              </div>
            )}

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

            {asking.length > 0 && (
              <div className={styles.padBlock}>
                <span className={styles.padLabel}>Your initials</span>
                <p className={styles.smallNote}>
                  {asking.length === 1 ? "One section asks for them." : `${asking.length} sections ask for them.`} Draw them once, then add them to each.
                </p>
                <div className={styles.initialsPad}>
                  <Pad value={initials} onChange={drawInitials} label="Draw your initials" height={100} />
                </div>
                <ul className={styles.initialsList}>
                  {asking.map((s) => {
                    const title = s.title.trim() || "This section";
                    const on = Boolean(initials) && initialedNow.has(s.id);
                    return (
                      <li key={s.id} className={styles.initialsRow} data-on={on || undefined}>
                        <span className={styles.initialsText}>
                          <strong>{title}</strong>
                          <span>{s.place === "signatures" ? "Above the signatures" : "On the terms pages"}</span>
                        </span>
                        {on ? (
                          <>
                            <img className={styles.initialsMark} src={initials!} alt="" />
                            <button type="button" className={styles.textButton} onClick={() => initial(s, false)}>
                              Remove<span className="sr-only"> the initials from {title}</span>
                            </button>
                          </>
                        ) : (
                          <button type="button" className={`btn btn-primary ${styles.touch}`} disabled={!initials} onClick={() => initial(s, true)}>
                            <Icon name="pen" size={16} />
                            Add my initials<span className="sr-only"> to {title}</span>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

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
            {changed && (
              <button type="button" className={`btn ${styles.touch}`} onClick={checkAgain}>
                <Icon name="refresh" size={17} />
                Check it again
              </button>
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
