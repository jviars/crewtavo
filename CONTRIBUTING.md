# Contributing to Crewtavo

Thanks for helping. Crewtavo is used by small service businesses that don't have a developer, so
the bar is: it works the first time, it explains itself, and it never loses anyone's data.

## Getting set up

Follow [Develop](README.md#develop) in the README: `npm install`, `npx supabase start`, copy
`.dev.vars.example` to `.dev.vars`, then `npm run dev:api` and `npm run dev`. `npm run seed:demo`
loads a demo company to click around in.

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Branch from `main` and keep the change focused on one thing.
3. Match the code around you: TypeScript everywhere, 2-space indent, comments that say *why*.
4. Schema changes go in a new file in `supabase/migrations` (never edit one that's already
   released), with row-level security for every new table and a test in `supabase/tests`. Then run
   `npm run db:types`.
5. Words people read in the app are plain and short. Say what happened and what to do next.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run test:db
```

If you touched a screen, also run `npm run test:browser` (it needs the local stack and
`npm run seed:demo`). CI runs all of these on every pull request.

## Reporting bugs and security issues

Bugs and ideas: [open an issue](https://github.com/jviars/crewtavo/issues/new/choose).
Security problems: please don't open a public issue; see [SECURITY.md](SECURITY.md).
