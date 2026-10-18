# The public demo

crewtavo.com's **Try the demo** opens a Crewtavo instance built from the `demo` branch. Nobody signs
up: every visitor gets their own copy of Acme Paving, a sample paving company (the same data as
`npm run seed:demo`), and copies are deleted after 24 hours.

- **Start screen** (`apps/web/src/features/demo`): shown instead of sign-in. A link ending in `?start`
  opens the demo without the extra click.
- **Demo bar** above the app: switch between the owner (Dana) and the crew lead's phone screens
  (Marcus), open the client portal (Jordan Rivera), or go to the guided setup on crewtavo.com.
- **API** (`apps/api/src/routes/demo.ts`, `apps/api/src/services/demo.ts`): `POST /api/demo/start`
  makes the copy and signs the visitor in; `POST /api/demo/switch` changes person. The accounts have
  random passwords nobody knows, under `@demo.crewtavo.com`; sessions come from one-time sign-in
  links the server redeems itself, so nothing is emailed. Starting a copy is limited to 6 an hour per
  address and 300 an hour in total.
- **Cleanup**: the `demo` background task runs hourly and deletes copies older than 24 hours, with
  their accounts and uploaded files. It only touches companies whose owner is a demo account.

## Running it

The instance is an ordinary Crewtavo instance (the Railway template), with the `crewtavo` service
built from this branch instead of the release image, and two settings on it:

| Variable | Value | Why |
| --- | --- | --- |
| `CREWTAVO_DEMO` | `1` | Turns on the start screen, the demo bar, the API and the cleanup task |
| `CREWTAVO_SINGLE_COMPANY` | `0` | An instance normally holds one business; the demo holds one per visitor |

Leave email, texting, payments and AI unset, so nothing leaves the demo.

To try it locally, add both lines to `.env.instance` and run `npm run instance`.

## Keeping it current

Merge `main` into `demo` and push; Railway rebuilds the demo from the branch.
