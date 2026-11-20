/**
 * The translation layer (src/i18n): plurals, contexts, placeholders, falling back to English,
 * es-US formatting, notifications and errors read by their shape, and the catalog check: every
 * t()/msg()/<T> text in the code has its Spanish line, and every Spanish line is still used.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogProblems, sqlFunction } from "../../../scripts/i18n.mjs";
import { addCatalog, english, getLocale, intlLocaleOf, LOCALES, msg, setLanguageChoice, setLocale, t, translator } from "../src/i18n";
import { installSpanish } from "../src/i18n/es";
import { NOTICES } from "../src/i18n/es/notices";
import { compilePattern, spanishDate, translateError, translateNotice } from "../src/i18n/patterns";

addCatalog("es", {
  "Test: Clock in": "Test: Marcar entrada",
  "Test: Hello {name}": "Test: Hola {name}",
  "Test: {count} visits": { one: "Test: {count} visita", other: "Test: {count} visitas", many: "Test: {count} de visitas" },
  "verb::Test: Open": "Test: Abrir",
  "state::Test: Open": "Test: Abierta",
});

// These check the Spanish itself, so with people able to choose it.
beforeAll(() => setLanguageChoice(true));
afterAll(() => setLanguageChoice(false));

describe("with no choice of language", () => {
  it("answers everyone in English, whatever their profile holds", () => {
    installSpanish();
    setLanguageChoice(false);
    try {
      expect(translator("es")("Today")).toBe("Today");
      expect(translator("es").locale).toBe("en");
    } finally {
      setLanguageChoice(true);
    }
  });
});

describe("t", () => {
  it("is English as it's written until a language is chosen", () => {
    expect(getLocale()).toBe("en");
    expect(t("Test: Clock in")).toBe("Test: Clock in");
    expect(t("Test: Hello {name}", { name: "Ana" })).toBe("Test: Hello Ana");
    expect(t("Not in any catalog")).toBe("Not in any catalog");
  });

  it("speaks the language set for the app", () => {
    setLocale("es");
    try {
      expect(t("Test: Clock in")).toBe("Test: Marcar entrada");
      expect(t("Test: Hello {name}", { name: "Ana" })).toBe("Test: Hola Ana");
      expect(t.locale).toBe("es");
    } finally {
      setLocale("en");
    }
  });

  it("falls back to the English for a line with no translation", () => {
    const es = translator("es");
    expect(es("Not in any catalog")).toBe("Not in any catalog");
    expect(es("Still English, {who}", { who: "Luis" })).toBe("Still English, Luis");
  });

  it("fills placeholders, numbers too, and leaves one with no value as it is", () => {
    const en = translator("en");
    expect(en("{a} of {b}", { a: 3, b: 10 })).toBe("3 of 10");
    expect(en("Hi {name}", {})).toBe("Hi {name}");
    expect(en("Hi {name}", { name: null })).toBe("Hi ");
  });

  it("tells the same English apart by its context", () => {
    const es = translator("es");
    expect(es("Test: Open", { context: "verb" })).toBe("Test: Abrir");
    expect(es("Test: Open", { context: "state" })).toBe("Test: Abierta");
    // msg() keeps the context with the text, for a constant translated where it's shown.
    const label = msg("Test: Open", "state");
    expect(es(label)).toBe("Test: Abierta");
    expect(translator("en")(label)).toBe("Test: Open");
    expect(english(label)).toBe("Test: Open");
    expect(msg("Schedule")).toBe("Schedule");
  });

  it("says one o'clock as Spanish does: \"a la 1:15\", and \"a las\" for every other hour", () => {
    addCatalog("es", { "Test: Starts at {time}": "Test: Empieza a las {time}", "Test: Since {time}, {count} visits": { one: "Test: Desde las {time}, {count} visita", other: "Test: Desde las {time}, {count} visitas" } });
    const es = translator("es");
    expect(es("Test: Starts at {time}", { time: "1:15 p.m." })).toBe("Test: Empieza a la 1:15 p.m.");
    expect(es("Test: Starts at {time}", { time: "1:00 a.m." })).toBe("Test: Empieza a la 1:00 a.m.");
    for (const time of ["2:15 p.m.", "10:15 a.m.", "11:00 a.m.", "12:30 p.m."]) expect(es("Test: Starts at {time}", { time })).toBe(`Test: Empieza a las ${time}`);
    expect(es.plural(2, { one: "Test: Since {time}, {count} visit", other: "Test: Since {time}, {count} visits" }, { time: "1:05 p.m." })).toBe("Test: Desde la 1:05 p.m., 2 visitas");
    expect(translator("en")("Test: Starts at {time}", { time: "1:15 PM" })).toBe("Test: Starts at 1:15 PM");
  });

  it("takes a translator per person, whatever the app's language", () => {
    expect(translator("es")("Test: Clock in")).toBe("Test: Marcar entrada");
    expect(translator(null)("Test: Clock in")).toBe("Test: Clock in");
    expect(translator("fr")("Test: Clock in")).toBe("Test: Clock in");
    expect(translator("es").locale).toBe("es");
  });
});

describe("t.plural", () => {
  const forms = { one: "Test: {count} visit", other: "Test: {count} visits" };

  it("picks English's one and other", () => {
    const en = translator("en");
    expect(en.plural(1, forms)).toBe("Test: 1 visit");
    expect(en.plural(0, forms)).toBe("Test: 0 visits");
    expect(en.plural(2, forms)).toBe("Test: 2 visits");
  });

  it("picks Spanish's forms, with many for millions and other when many is missing", () => {
    const es = translator("es");
    expect(es.plural(1, forms)).toBe("Test: 1 visita");
    expect(es.plural(0, forms)).toBe("Test: 0 visitas");
    expect(es.plural(5, forms)).toBe("Test: 5 visitas");
    expect(es.plural(1_000_000, forms)).toBe("Test: 1000000 de visitas");
    addCatalog("es", { "Test: {count} hours": { one: "Test: {count} hora", other: "Test: {count} horas" } });
    expect(es.plural(1_000_000, { one: "Test: {count} hour", other: "Test: {count} hours" })).toBe("Test: 1000000 horas");
  });

  it("falls back to English when there's no Spanish, and takes other placeholders", () => {
    const es = translator("es");
    expect(es.plural(3, { one: "{count} photo of {who}", other: "{count} photos of {who}" }, { who: "Ana" })).toBe("3 photos of Ana");
  });
});

describe("formatting", () => {
  it("is es-US for Spanish: US numbers and money, Spanish words", () => {
    expect(LOCALES).toEqual(["en", "es"]);
    expect(intlLocaleOf("en")).toBe("en-US");
    expect(intlLocaleOf("es")).toBe("es-US");
    const money = (tag: string) => new Intl.NumberFormat(tag, { style: "currency", currency: "USD" }).format(1234.5);
    expect(money(intlLocaleOf("en"))).toBe("$1,234.50");
    expect(money(intlLocaleOf("es"))).toBe("$1,234.50");
    const day = new Date("2026-10-15T12:00:00Z");
    expect(day.toLocaleDateString(intlLocaleOf("en"), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })).toBe("Thu, Oct 15");
    expect(day.toLocaleDateString(intlLocaleOf("es"), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })).toBe("jue, 15 de oct");
    expect(day.toLocaleTimeString(intlLocaleOf("es"), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).replace(/\s/g, " ")).toBe("12:00 p.m.");
  });
});

describe("text written in English, read by its shape", () => {
  installSpanish();

  it("turns the database's English dates into Spanish ones", () => {
    expect(spanishDate("Thu Oct 15, 9:00 AM")).toBe("jue, 15 de oct, 9:00 a.m.");
    expect(spanishDate("Thu Oct 15")).toBe("jue, 15 de oct");
    expect(spanishDate("Mon, Sep 7 at 12:30 PM")).toBe("lun, 7 de sept, 12:30 p.m.");
    expect(spanishDate("Oct 15, 2026")).toBe("15 de oct de 2026");
    expect(spanishDate("Oct 5")).toBe("5 de oct");
    expect(spanishDate("6:00 PM Thu")).toBe("6:00 p.m. del jueves");
    expect(spanishDate("7:05 AM")).toBe("7:05 a.m.");
    expect(spanishDate("Mow the lawn")).toBeNull();
  });

  it("reads a pattern's captures anchored at both ends, a date only where a date is", () => {
    const re = compilePattern("{title} moved to {when} (was {was})");
    expect("Mow moved to Thu Oct 15 (was Wed Oct 14)".match(re)?.groups).toEqual({ title: "Mow", when: "Thu Oct 15", was: "Wed Oct 14" });
    expect(re.test("Mow moved to Thu Oct 15")).toBe(false);
    // Not a date: not this sentence.
    expect(re.test("Mow moved to the back yard (was the front)")).toBe(false);
  });

  it("splits a sentence around the date's own shape, so a title with \" on \" or \": \" in it stays whole", () => {
    expect("Work on deck on Thu Oct 15, 9:00 AM was cancelled".match(compilePattern("{title} on {when} was cancelled"))?.groups).toEqual({ title: "Work on deck", when: "Thu Oct 15, 9:00 AM" });
    expect("Lights on on on Thu Oct 15 was cancelled".match(compilePattern("{title} on {when} was cancelled"))?.groups).toEqual({ title: "Lights on on", when: "Thu Oct 15" });
    expect("You're on Deck: stage 2: Thu Oct 15, 9:00 AM".match(compilePattern("You're on {title}: {when}"))?.groups).toEqual({ title: "Deck: stage 2", when: "Thu Oct 15, 9:00 AM" });
    expect("Fence (was Gate) moved to Mon Nov 16 (was Fri Nov 13)".match(compilePattern("{title} moved to {when} (was {was})"))?.groups).toEqual({ title: "Fence (was Gate)", when: "Mon Nov 16", was: "Fri Nov 13" });
    expect(compilePattern("{count} changes to your schedule").test("Big changes to your schedule")).toBe(false);
  });

  it("leaves English readers' notices and errors as they are", () => {
    const notice = { kind: "time", title: "Your clock is still running", body: "Started at 7:00 AM, 11 hours ago. Stop it if the day is done." };
    expect(translateNotice("en", notice)).toBe(notice);
    expect(translateNotice(null, notice)).toBe(notice);
    expect(translateError("en", "Something went wrong.")).toBe("Something went wrong.");
  });

  it("leaves what it doesn't know in English", () => {
    expect(translateNotice("es", { kind: "schedule", title: "Something no table knows", body: null })).toEqual({ kind: "schedule", title: "Something no table knows", body: null });
    expect(translateError("es", "A message no table knows")).toBe("A message no table knows");
  });
});

// ---------------------------------------------------------------------------------------------
// The database's own words: what its functions write today, read out of supabase/migrations
// ---------------------------------------------------------------------------------------------

/** A function's text as it's defined last (the newest migration that creates or replaces it), quotes as they're read. */
const sqlOf = sqlFunction;

/** Sentences the database puts together from parts: the parts to find in its text. */
const ASSEMBLED: Record<string, string[]> = {
  "{plan} is overdue on {machine}": ["%s is %s on %s", "'overdue'"],
  "{plan} is coming due on {machine}": ["%s is %s on %s", "'coming due'"],
  "Due {date} or at {reading} {wordMeter} (now {now})": ["'Due '", "' or '", "at %s %s", " (now %s)"],
  "Due {date} or at {reading} {wordMeter}": ["'Due '", "' or '", "at %s %s"],
  "Due at {reading} {wordMeter} (now {now})": ["'Due '", "at %s %s", " (now %s)"],
  "Due at {reading} {wordMeter}": ["'Due '", "at %s %s"],
  "{client} asked to cancel {title}": ["%s asked to %s %s", "'cancel'"],
  "{client} asked to move {title}": ["%s asked to %s %s", "'move'"],
};

/**
 * Whether the database still writes a sentence: as one format() text (each {capture}, and a number
 * written out, a %s), else every run of its words between captures and punctuation.
 */
function writtenBy(english: string, sql: string): string[] {
  if (ASSEMBLED[english]) return ASSEMBLED[english]!.filter((part) => !sql.includes(part));
  if (sql.includes(english.replace(/\{\w+\}|\b\d+\b/g, "%s"))) return [];
  return english
    .split(/\{\w+\}/)
    .flatMap((piece) => piece.split(/(?<=[.:,)])\s+/))
    .map((piece) => piece.trim().replace(/^\(|\)$/g, ""))
    .filter((piece) => (piece.match(/[A-Za-z]/g) ?? []).length >= 2 && !sql.includes(piece));
}

/** A value for a capture, as the database would write it: a tricky title, and dates in each of its formats. */
function sample(name: string): string {
  if (name === "time2") return "6:00 PM Thu";
  if (/^time/.test(name)) return "7:05 AM";
  if (name === "date") return "Nov 25, 2026";
  if (/^(when|was)/.test(name)) return name === "was" ? "Wed Oct 14" : "Thu Oct 15, 9:00 AM";
  if (/^(count|number|days|hours)/.test(name)) return "12";
  if (name === "wordDoc") return "liability insurance";
  if (name === "wordMeter") return "miles";
  if (name === "line") return "Smith roof, Tue Nov 3 to Thu Nov 5, 24 squares, $2,040";
  if (name === "title" || name === "job" || name === "file") return "Work on deck: phase 2";
  if (/price|old|amount/.test(name)) return "$1,200";
  return "Ana Ortiz";
}
const written = (english: string) => english.replace(/\{(\w+)\}/g, (_, name: string) => sample(name));
/** English a Spanish reader shouldn't be left with: the database's month, weekday and AM/PM. */
const ENGLISH_DATE = /\b(?:AM|PM|Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Apr|Aug|Dec)\b/;

describe("notifications to the team, in Spanish", () => {
  installSpanish();
  const es = (kind: string, title: string, body: string | null = null) => {
    const { title: t2, body: b2 } = translateNotice("es", { kind, title, body });
    return { title: t2, body: b2 };
  };

  it("knows every sentence as the database writes it today: a change of wording in a migration fails here", () => {
    const stale: string[] = [];
    for (const group of NOTICES) {
      const sql = group.from.map(sqlOf).join("\n");
      // The kind it's written under, too.
      if (!sql.includes(`'${group.kind}'`)) stale.push(`${group.from.join(", ")} no longer write kind '${group.kind}'`);
      for (const [english] of [...group.titles, ...group.bodies]) {
        const missing = writtenBy(english, sql);
        if (missing.length) stale.push(`[${group.kind}] "${english}" isn't what ${group.from.join(", ")} write any more (not found: ${missing.join(" | ")})`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("puts every sentence the database writes into Spanish whole, with its dates, and a tricky title left as it is", () => {
    for (const group of NOTICES) {
      for (const [english, translation] of group.titles) {
        const title = written(english);
        const out = es(group.kind, title);
        if (translation !== english) expect(out.title, title).not.toBe(title);
        expect(out.title, title).not.toMatch(ENGLISH_DATE);
        if (english.includes("{title}")) expect(out.title, title).toContain("Work on deck: phase 2");
      }
      for (const [english, translation] of group.bodies) {
        const body = written(english);
        const out = es(group.kind, written(group.titles[0]![0]), body);
        if (translation !== english) expect(out.body, body).not.toBe(body);
        expect(out.body, body).not.toMatch(ENGLISH_DATE);
      }
    }
  });

  it("reads the schedule changes the database writes, one line at a time", () => {
    expect(es("schedule", "You're on Smith mowing: Thu Nov 12, 7:00 AM").title).toBe("Te pusieron en Smith mowing: jue, 12 de nov, 7:00 a.m.");
    expect(es("schedule", "You're off Smith mowing (Thu Nov 12)").title).toBe("Te quitaron de Smith mowing (jue, 12 de nov)");
    expect(es("schedule", "Hedges on Fri Nov 13, 9:30 AM was cancelled").title).toBe("Se canceló Hedges del vie, 13 de nov, 9:30 a.m.");
    expect(es("schedule", "Hedges moved to Mon Nov 16 (was Fri Nov 13)").title).toBe("Hedges se movió al lun, 16 de nov (era el vie, 13 de nov)");
    expect(es("schedule", "Hedges now starts Fri Nov 13, 10:00 AM").title).toBe("Hedges ahora empieza el vie, 13 de nov, 10:00 a.m.");
    expect(es("schedule", "You're on Hedges: no date yet").title).toBe("Te pusieron en Hedges: todavía sin fecha");
    expect(es("schedule", "2 changes to your schedule", "You're on A: Thu Nov 12\nB on Fri Nov 13 was cancelled")).toEqual({
      title: "2 cambios en tu agenda",
      body: "Te pusieron en A: jue, 12 de nov\nSe canceló B del vie, 13 de nov",
    });
  });

  it("tells someone their time was changed or deleted, with what it was, what it is now and the reason as it was typed", () => {
    expect(es("time", "Pat Owner changed your time on Mon Nov 9", "It was 8:00 AM to 12:00 PM.\nIt's now 8:00 AM to 11:30 AM.\nIt's now marked as a break.\nWhy: Left at 11:30 on Mon Nov 9")).toEqual({
      title: "Pat Owner cambió tu tiempo del lun, 9 de nov",
      body: "Era de las 8:00 a.m. a las 12:00 p.m.\nAhora es de las 8:00 a.m. a las 11:30 a.m.\nAhora está marcado como descanso.\nMotivo: Left at 11:30 on Mon Nov 9",
    });
    expect(es("time", "Lou Lead deleted your time on Tue Nov 10", "It was running since 1:05 PM.")).toEqual({ title: "Lou Lead eliminó tu tiempo del mar, 10 de nov", body: "Estaba corriendo desde la 1:05 p.m." });
    expect(es("time", "Pat Owner changed your time on Wed Nov 11", "It was running since 8:00 AM.\nIt's now 8:00 AM to 10:00 AM.").body).toBe("Estaba corriendo desde las 8:00 a.m.\nAhora es de las 8:00 a.m. a las 10:00 a.m.");
  });

  it("keeps a title whole when it has \" on \" or \": \" in it", () => {
    expect(es("schedule", "Work on deck on Thu Oct 15, 9:00 AM was cancelled").title).toBe("Se canceló Work on deck del jue, 15 de oct, 9:00 a.m.");
    expect(es("schedule", "You're on Deck: stage 2: Thu Oct 15, 9:00 AM").title).toBe("Te pusieron en Deck: stage 2: jue, 15 de oct, 9:00 a.m.");
    expect(es("schedule", "Check on Mrs. Lee now starts Fri Nov 13, 10:00 AM").title).toBe("Check on Mrs. Lee ahora empieza el vie, 13 de nov, 10:00 a.m.");
  });

  it("leaves the whole notification in English when any of it isn't a shape its kind writes, rather than half of it", () => {
    const batch = { kind: "schedule", title: "3 changes to your schedule", body: "You're on A: Thu Nov 12\nB on Fri Nov 13 was cancelled\nSomething a newer server writes" };
    expect(translateNotice("es", batch)).toBe(batch);
    const odd = { kind: "time", title: "Your clock is still running", body: "Something new about it." };
    expect(translateNotice("es", odd)).toBe(odd);
    const title = { kind: "jobs", title: "A new kind of news", body: "New job offer." };
    expect(translateNotice("es", title)).toBe(title);
  });

  it("goes by the notification's kind: the same words under another kind, or none, are left alone", () => {
    for (const kind of ["alerts", "client", "chat", "quote", "info", "", null, undefined]) {
      const notice = { kind, title: "Hedges on Fri Nov 13, 9:30 AM was cancelled", body: "Hedges on Fri Nov 13, 9:30 AM was cancelled" };
      expect(translateNotice("es", notice)).toBe(notice);
    }
    const noKind = { title: "Your clock is still running", body: null };
    expect(translateNotice("es", noKind)).toBe(noKind);
  });

  it("never rewrites what somebody typed: a chat message, a client's message or reason, a note", () => {
    // A coworker's words, which happen to look like the database's sentences about machines, pay and paperwork.
    for (const words of ["Carlos is overdue on his timesheet", "Due tomorrow", "Paid 200 on Friday for the mulch", "Your license ends today", "Truck 2 on Thu Oct 15 was cancelled", "You're on Smith mowing: Thu Nov 12, 7:00 AM", "New job offer."]) {
      expect(es("chat", "Ana Ortiz mentioned you in #crew", words)).toEqual({ title: "Ana Ortiz te mencionó en #crew", body: words });
      // A client's own message, or anything an automation says: not a kind with shapes, or not its shapes.
      const fromClient = { kind: "client", title: "New message from Ann Lee", body: words };
      expect(translateNotice("es", fromClient)).toBe(fromClient);
      const alert = { kind: "alerts", title: words, body: words };
      expect(translateNotice("es", alert)).toBe(alert);
    }
    // Their reason and their message ride along as written, inside the database's own sentence.
    expect(es("client", "Ann Lee asked to cancel Hedges", "Booked Fri Nov 13, 9:30 AM. Reason: Paid 200 on Friday, due tomorrow").body).toBe("Programada el vie, 13 de nov, 9:30 a.m. Motivo: Paid 200 on Friday, due tomorrow");
    expect(es("client", "Ann Lee asked to move Hedges", 'Booked Fri Nov 13, 9:30 AM. "Your crew is overdue on our hedge"').body).toBe('Programada el vie, 13 de nov, 9:30 a.m. "Your crew is overdue on our hedge"');
    // Only the database's stand-in for a message with no words is translated, and only whole.
    expect(es("chat", "Ana Ortiz posted in #crew", "Sent a photo")).toEqual({ title: "Ana Ortiz publicó en #crew", body: "Envió una foto" });
    expect(es("chat", "Ana Ortiz posted in #crew", "Sent a photo of the gate").body).toBe("Sent a photo of the gate");
  });

  it("reads the clock's reminders and the stop it made, with one o'clock and one hour said right", () => {
    expect(es("time", "Your clock was stopped for you", "It started at 7:05 AM and was still running, so it was stopped at 6:00 PM Thu. Fix the end time on Timesheets if that's wrong.")).toEqual({
      title: "Tu reloj se paró solo",
      body: "Empezó a las 7:05 a.m. y seguía corriendo, así que se paró a las 6:00 p.m. del jueves. Corrige la hora de salida en Hojas de horas si no está bien.",
    });
    expect(es("time", "Rosa Ruiz's clock is still running", "Started at 6:00 AM, 11 hours ago. Stop it if the day is done.")).toEqual({
      title: "El reloj de Rosa Ruiz sigue corriendo",
      body: "Empezó a las 6:00 a.m., hace 11 horas. Páralo si ya terminó el día.",
    });
    // "a la 1:15", never "a las 1:15"; ten and twelve keep "las". And "hace 1 hora" for the database's "1 hours".
    expect(es("time", "Your clock is still running", "Started at 1:15 PM, 1 hours ago. Stop it if the day is done.").body).toBe("Empezó a la 1:15 p.m., hace 1 hora. Páralo si ya terminó el día.");
    expect(es("time", "Your clock is still running", "On the clock since 11:15 AM, 10 hours ago. Stop it if the day is done.").body).toBe("En el reloj desde las 11:15 a.m., hace 10 horas. Páralo si ya terminó el día.");
    expect(es("time", "Your clock was stopped for you", "It had been running since 1:05 AM, so it was stopped at 1:00 PM Thu. Fix the end time on Timesheets if that's wrong.").body).toBe(
      "Estaba corriendo desde la 1:05 a.m., así que se paró a la 1:00 p.m. del jueves. Corrige la hora de salida en Hojas de horas si no está bien.",
    );
  });

  it("reads a sub's offers and pay, and their paperwork", () => {
    expect(es("jobs", "Smith roof, Tue Nov 3 to Thu Nov 5, 24 squares, $2,040. Answer by Mon Nov 2, 5:00 PM. Open Crewtavo to accept or decline.", "New job offer.")).toEqual({
      title: "Smith roof, mar 3 de nov a jue 5 de nov, 24 cuadros, $2,040. Responde antes del lun, 2 de nov, 5:00 p.m. Abre Crewtavo para aceptar o rechazar.",
      body: "Nueva oferta de trabajo.",
    });
    expect(es("jobs", "Paid $1,200 on Nov 10", "Smith roof, by check.")).toEqual({ title: "Pagado $1,200 el 10 de nov", body: "Smith roof, con cheque." });
    // Whatever the document is called ("tu licencia", "tu seguro"), "the new one" reads right.
    expect(es("subs", "Your liability insurance ends in 12 days", "It ends Nov 25, 2026. Send us the new one under My paperwork.")).toEqual({
      title: "Tu seguro de responsabilidad civil vence en 12 días",
      body: "Vence el 25 de nov de 2026. Envíanos el documento nuevo en Mis documentos.",
    });
    expect(es("subs", "Your license has run out", "It ended Nov 1, 2026. Send us the new one under My paperwork.").title).toBe("Tu licencia venció");
    // The same kind, written for the office about a sub: not a shape for the crew, so English whole.
    const office = { kind: "subs", title: "Ace Roofing's liability insurance ends in 12 days", body: "It ends Nov 25, 2026. We're sending them a link to send in a new one." };
    expect(translateNotice("es", office)).toBe(office);
  });

  it("reads a machine coming due, and a client asking to move a visit", () => {
    expect(es("equipment", "Oil change is coming due on Truck 2", "Due Nov 20 or at 5,000 miles (now 4,820)")).toEqual({
      title: "Oil change ya casi toca en Truck 2",
      body: "Toca el 20 de nov o al llegar a 5,000 millas (ahora 4,820)",
    });
    expect(es("client", "Ann Lee asked to move Hedges", "Booked Fri Nov 13, 9:30 AM. Asked for Mon Nov 16.").body).toBe("Programada el vie, 13 de nov, 9:30 a.m. Pidió el lun, 16 de nov.");
  });

  it("reads the errors a crew member can meet", () => {
    expect(translateError("es", "You can change a visit's status and notes. Ask the office about anything else.")).toBe("Puedes cambiar el estado y las notas de una visita. Pregúntale a la oficina por lo demás.");
    expect(translateError("es", "Your workers' comp certificate on file has run out.")).toBe("Tu certificado de compensación laboral que tenemos venció.");
    // "The new one" is the document, so it reads right after "tu licencia" or "tu exención" as after "tu seguro".
    expect(translateError("es", "Your license on file has run out. We'll check the new one you sent.")).toBe("Tu licencia que tenemos venció. Vamos a revisar el documento nuevo que enviaste.");
    expect(translateError("es", "We haven't checked the workers' comp exemption you sent yet.")).toBe("Todavía no revisamos tu exención de compensación laboral que enviaste.");
    expect(translateError("es", "The lines and tax come to $86.40, not the $90.00 total. Check them.")).toBe("Las líneas y el impuesto suman $86.40, no el total de $90.00. Revísalos.");
    // Sending from the field to someone whose texts are off.
    expect(translateError("es", "Texts off")).toBe("Mensajes de texto desactivados");
    expect(translateError("es", "Pat Lee asked not to be texted, so texts to them are off. Send it by email instead.")).toBe("Pat Lee pidió no recibir mensajes de texto, así que están desactivados. Envíalo por correo.");
    expect(translateError("es", "540-555-0133 asked not to be texted, so Crewtavo can't text it.")).toBe("540-555-0133 pidió no recibir mensajes de texto, así que Crewtavo no puede enviarle.");
  });
});

describe("Spanish as it's said", () => {
  installSpanish();
  const es = translator("es");

  it("counts one required answer as one: \"falta 1 obligatorio\", \"faltan 3 obligatorios\"", () => {
    expect(es(msg("{count} required left", "one"), { count: 1 })).toBe("falta 1 obligatorio");
    expect(es("{count} required left", { count: 3 })).toBe("faltan 3 obligatorios");
  });

  it("says \"antes del\" before a date, names driving as a noun, and the hour of one as \"la 1\"", () => {
    expect(es("Answer by {when}", { when: "jue, 15 de oct, 5:00 p.m." })).toBe("Responde antes del jue, 15 de oct, 5:00 p.m.");
    expect(es("You left {place}, so your clock is on driving", { place: "12 Oak St" })).toBe("Saliste de 12 Oak St, así que tu reloj ahora cuenta como manejo");
    expect(es("Switch to driving")).toBe("Cambiar a manejo");
    expect(es("{when} at {time}", { when: "jue, 15 de oct", time: "1:30 p.m." })).toBe("jue, 15 de oct a la 1:30 p.m.");
    expect(es("{when} at {time}", { when: "jue, 15 de oct", time: "11:30 a.m." })).toBe("jue, 15 de oct a las 11:30 a.m.");
  });
});

describe("the Spanish catalog", () => {
  it("has a line for every text the code translates, and nothing left over", () => {
    expect(catalogProblems()).toEqual([]);
  }, 60_000);
});
