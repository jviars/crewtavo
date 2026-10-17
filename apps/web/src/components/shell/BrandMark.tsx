/** The Crewtavo mark (same shapes as public/crewtavo-mark.svg). */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={(size * 211) / 251} height={size} viewBox="0 0 211 251" aria-hidden="true" focusable="false">
      <path fill="var(--brand-ink, #182430)" d="M115 0 156.2 23.8 41.5 90 41.5 157.1 115 199.5 115 247.4 0 181 0 66.4Z" />
      <path fill="#F4B143" d="M156.2 56 211 87.64 211 125.64 156.2 94 70 143.77 70 105.77Z" />
      <path fill="var(--brand-ink, #182430)" d="M156.2 124 211 155.64 211 193.14 156.2 161.5ZM156.2 181.5 211 213.14 211 250.64 156.2 219Z" />
    </svg>
  );
}

/** Mark and name together, for the sidebar and sign-in pages. */
export function BrandLockup({ size = 28 }: { size?: number }) {
  return (
    <>
      <BrandMark size={size} />
      <span className="brand-name">Crewtavo</span>
    </>
  );
}
