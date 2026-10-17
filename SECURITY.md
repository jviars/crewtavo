# Security

Crewtavo holds businesses' client lists, prices, payments and sign-ins, so security reports are
taken seriously.

## Reporting a vulnerability

Please report it privately through GitHub: on this repository, open **Security → Report a
vulnerability**. Don't open a public issue.

Include what you found, how to reproduce it, and what someone could do with it. You'll get a reply
within a few days, and credit in the fix if you'd like it.

## Supported versions

Fixes go into `main`. Instances pick them up on their next deploy, and database migrations run by
themselves when the new version starts.

## How Crewtavo protects data

- Each business runs its own instance with its own database. Nothing is shared between businesses.
- Row-level security in Postgres enforces every role's access, not just the screens
  (`supabase/migrations`, tested in `supabase/tests`).
- Tokens for connected apps are encrypted, and client links are signed and expire.
- Error reports, when turned on, have personal data removed before they leave the server or the
  browser (`packages/core/src/privacy.ts`).
