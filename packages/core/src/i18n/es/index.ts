/**
 * The Spanish catalog (Latin American and US Spanish, tú in the app): see GLOSSARY.md before
 * writing a line. The web app loads it as its own file, only for someone using Spanish, and the
 * service worker keeps it for when there's no signal; the API loads it at start-up.
 */
import { addCatalog } from "../index";
import { addPatterns } from "../patterns";
import common from "./common";
import { ERRORS } from "./errors";
import field from "./field";
import { NOTICE_WORDS, NOTICES } from "./notices";
import office from "./office";
import server from "./server";
import team from "./team";

/** By area, so each line is read in the screen it's for. */
export const parts = { common, field, team, office, server };

let installed = false;

/** Makes Spanish available to t(), translator("es"), translateNotice and translateError. */
export function installSpanish() {
  if (installed) return;
  installed = true;
  for (const lines of Object.values(parts)) addCatalog("es", lines);
  addPatterns("es", { notices: NOTICES, errors: ERRORS, words: NOTICE_WORDS });
}
