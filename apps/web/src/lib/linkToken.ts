/**
 * A signed link's token as the server made it (apps/api/src/lib/crypto.ts signToken): its two parts.
 * A text or chat app that took the full stop or bracket after a link into it still opens the page
 * (a Client Hub link, a referral, paperwork or unsubscribe link), since the server reads nothing
 * more. Anything that isn't such a token is left as it is.
 */
export const linkToken = (raw: string) => /^[\w-]+\.[\w-]+/.exec(raw)?.[0] ?? raw;
