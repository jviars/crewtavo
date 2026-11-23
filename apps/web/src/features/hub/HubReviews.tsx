/**
 * "What clients say on Google" on a quote in the Client Hub: the business's Google rating and
 * count, and up to three of its Google reviews (the server's quoteReviewsFor picks them), when it
 * shows them on quotes (Marketing → Reviews). They're Google's, shown as Google has them: the
 * reviewer's name and their words unchanged, a long review cut only beside a link to read it on
 * Google, and a link to the business's profile there. Nothing without any.
 */
import { fitReviews, HUB_REVIEW_CHARS } from "@crewtavo/core/reviews";
import { formatDate } from "@/lib/format";
import type { HubReviews as Reviews } from "./document";

export function HubReviews({ reviews }: { reviews: Reviews | null | undefined }) {
  if (!reviews) return null;
  const link = /^https:\/\//.test(reviews.link ?? "") ? reviews.link! : null;
  const shown = fitReviews(reviews.reviews, HUB_REVIEW_CHARS, link);
  if (!shown.length && !reviews.count) return null;
  return (
    <section className="hub-card hub-pad hub-reviews" aria-labelledby="hub-reviews">
      <h2 id="hub-reviews" className="hub-card-title">What clients say on Google</h2>
      {reviews.rating !== null && Boolean(reviews.count) && (
        <span className="hub-reviews-score">
          <span className="hub-stars" aria-hidden="true">★</span> <strong>{reviews.rating.toFixed(1)}</strong> on Google ·{" "}
          {reviews.count!.toLocaleString("en-US")} {reviews.count === 1 ? "review" : "reviews"}
        </span>
      )}
      {shown.length > 0 && (
        <div className="hub-reviews-list">
          {shown.map((r, i) => (
            <figure key={i} className="hub-review">
              <span className="hub-stars" role="img" aria-label={`${r.rating} out of 5 stars`}>{"★".repeat(r.rating)}</span>
              <blockquote>
                {r.text}
                {r.cut && link && <> <a href={link} target="_blank" rel="noreferrer">Read it on Google</a></>}
              </blockquote>
              <figcaption>{r.name} · {formatDate(r.date)} · Google review</figcaption>
            </figure>
          ))}
        </div>
      )}
      {link && (
        <a className="small" href={link} target="_blank" rel="noreferrer">
          See all reviews on Google
        </a>
      )}
    </section>
  );
}
