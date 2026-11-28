/**
 * Notifications to the team, by their kind and English shape (patterns.ts): the bell, push, email
 * and texts show them in the reader's language. Each group is one kind of notification
 * (notifications.kind) and names the database functions that write it; the English is exactly
 * what those write, and packages/core/test/i18n.test.ts holds every line against the functions'
 * own text in supabase/migrations, so a change of wording there fails the test until this follows.
 *
 * The more particular shape of two goes first. A kind with no group here (a client's message, an
 * automation's alert, anything for the office) stays in English.
 */
import type { NoticeGroup, PatternTable } from "../patterns";

/** One change to someone's schedule: a notification's title when it's the only one, and a line of its body. */
const SCHEDULE_LINES: PatternTable = [
  ["You're on {title}: {when}", "Te pusieron en {title}: {when}"],
  ["You're on {title}: no date yet", "Te pusieron en {title}: todavía sin fecha"],
  ["You're off {title} ({when})", "Te quitaron de {title} ({when})"],
  ["You're off {title} (no date yet)", "Te quitaron de {title} (todavía sin fecha)"],
  ["{title} on {when} was cancelled", "Se canceló {title} del {when}"],
  ["{title} is off the schedule for now (was {was})", "{title} salió de la agenda por ahora (era el {was})"],
  ["{title} moved to {when} (was {was})", "{title} se movió al {when} (era el {was})"],
  ["{title} now starts {when}", "{title} ahora empieza el {when}"],
  ["The upcoming visits for job #{number} ({title}) changed", "Cambiaron las próximas visitas del trabajo #{number} ({title})"],
  // Plans added to a job the crew works on
  ["New version of {file} for job #{number} ({title}): {revision}", "Nueva versión de {file} para el trabajo #{number} ({title}): {revision}"],
  ["New version of {file} for job #{number} ({title})", "Nueva versión de {file} para el trabajo #{number} ({title})"],
  ["{file} added to job #{number} ({title})", "Se agregó {file} al trabajo #{number} ({title})"],
];

export const NOTICES: readonly NoticeGroup[] = [
  // A crew member's schedule
  {
    kind: "schedule",
    from: ["private.notify_schedule", "private.schedule_line_taken_back", "private.notify_on_visit", "private.visit_change_notify", "private.visit_delete_notify", "private.recurring_change_notify", "private.plan_files_notify", "private.visit_when"],
    titles: [["{count} changes to your schedule", "{count} cambios en tu agenda"], ...SCHEDULE_LINES],
    bodies: SCHEDULE_LINES,
  },

  // The clock
  {
    kind: "time",
    from: ["public.clock_upkeep", "private.time_entry_changed"],
    titles: [
      // Someone else changed or deleted their time (the record of it is on Timesheets, under History).
      ["{name} changed your time on {date}", "{name} cambió tu tiempo del {date}"],
      ["{name} deleted your time on {date}", "{name} eliminó tu tiempo del {date}"],
      ["Your clock was stopped for you", "Tu reloj se paró solo"],
      ["Your clock is still running", "Tu reloj sigue corriendo"],
      ["{name}'s clock is still running", "El reloj de {name} sigue corriendo"],
    ],
    bodies: [
      ["It was running since {time}.", "Estaba corriendo desde las {time}."],
      ["It was {time} to {time2}.", "Era de las {time} a las {time2}."],
      ["It's now running since {time}.", "Ahora corre desde las {time}."],
      ["It's now {time} to {time2}.", "Ahora es de las {time} a las {time2}."],
      ["It's now marked as {wordType}.", "Ahora está marcado como {wordType}."],
      // Their reason, in their own words.
      ["Why: {reason}", "Motivo: {reason}"],
      ["It had been running since {time}, so it was stopped at {time2}. Fix the end time on Timesheets if that's wrong.", "Estaba corriendo desde las {time}, así que se paró a las {time2}. Corrige la hora de salida en Hojas de horas si no está bien."],
      ["It started at {time} and was still running, so it was stopped at {time2}. Fix the end time on Timesheets if that's wrong.", "Empezó a las {time} y seguía corriendo, así que se paró a las {time2}. Corrige la hora de salida en Hojas de horas si no está bien."],
      // The database writes "1 hours".
      ["On the clock since {time}, 1 hours ago. Stop it if the day is done.", "En el reloj desde las {time}, hace 1 hora. Páralo si ya terminó el día."],
      ["On the clock since {time}, {hours} hours ago. Stop it if the day is done.", "En el reloj desde las {time}, hace {hours} horas. Páralo si ya terminó el día."],
      ["Started at {time}, 1 hours ago. Stop it if the day is done.", "Empezó a las {time}, hace 1 hora. Páralo si ya terminó el día."],
      ["Started at {time}, {hours} hours ago. Stop it if the day is done.", "Empezó a las {time}, hace {hours} horas. Páralo si ya terminó el día."],
    ],
  },

  // Team chat. The body is the message itself, in its writer's words: never translated.
  {
    kind: "chat",
    from: ["private.chat_notify_mentions"],
    titles: [
      // A direct message, to one person or a group.
      ["{name} messaged you and 1 other", "{name} les escribió a ti y a 1 persona más"],
      ["{name} messaged you and {count} others", "{name} les escribió a ti y a {count} personas más"],
      ["{name} messaged you", "{name} te escribió"],
      ["{name} replied to you in {where}", "{name} te respondió en {where}"],
      ["{name} mentioned you in {where}", "{name} te mencionó en {where}"],
      ["{name} posted in {where}", "{name} publicó en {where}"],
    ],
    bodies: [["Sent a photo", "Envió una foto"]],
    freeBody: true,
  },

  // A sub's job offers and pay
  {
    kind: "jobs",
    from: ["private.tell_sub", "private.sub_offer_told", "private.job_pay_sub_notices"],
    titles: [
      ["New price for {job}: {price} (was {old}). Answer by {when}. Open Crewtavo to accept or decline.", "Precio nuevo para {job}: {price} (antes {old}). Responde antes del {when}. Abre Crewtavo para aceptar o rechazar."],
      ["New price for {job}: {price} (was {old}). Open Crewtavo to accept or decline.", "Precio nuevo para {job}: {price} (antes {old}). Abre Crewtavo para aceptar o rechazar."],
      ["{line}. Answer by {when}. Open Crewtavo to accept or decline.", "{line}. Responde antes del {when}. Abre Crewtavo para aceptar o rechazar."],
      ["{line}. Open Crewtavo to accept or decline.", "{line}. Abre Crewtavo para aceptar o rechazar."],
      ["The new price for {job} was withdrawn", "Se retiró el precio nuevo para {job}"],
      ["The offer for {job} was withdrawn", "Se retiró la oferta para {job}"],
      ["Your price for {job} is now {price} (was {old})", "Tu precio para {job} ahora es {price} (antes {old})"],
      ["{job} is yours at {price}", "{job} es tuyo por {price}"],
      ["Owed: {amount} for {job}", "Pendiente: {amount} por {job}"],
      ["Paid {amount} on {date}", "Pagado {amount} el {date}"],
    ],
    bodies: [
      ["New job offer.", "Nueva oferta de trabajo."],
      ["If you don't accept it, the price you agreed stands.", "Si no lo aceptas, se queda el precio que acordaste."],
      ["The price you agreed ({price}) stands.", "Se queda el precio que acordaste ({price})."],
      ["You don't need to do anything.", "No tienes que hacer nada."],
      ["The office agreed the new price with you.", "La oficina acordó contigo el precio nuevo."],
      ["The office agreed it with you. It's on My day.", "La oficina lo acordó contigo. Ya está en Mi día."],
      ["The work's done. We'll let you know when it's paid.", "El trabajo está terminado. Te avisamos cuando se pague."],
      ["{job}, by check.", "{job}, con cheque."],
      ["{job}, by bank transfer.", "{job}, por transferencia bancaria."],
      ["{job}, in cash.", "{job}, en efectivo."],
      ["{job}, by card or payment app.", "{job}, con tarjeta o aplicación de pago."],
      ["{job}, through payroll.", "{job}, por nómina."],
      // Paid some other way: the job's title and a period.
      ["{job}.", "{job}."],
    ],
  },

  // A sub's paperwork running out, told to the sub ("the new one" is the document, whatever it's called)
  {
    kind: "subs",
    from: ["public.emit_sub_document_alerts"],
    titles: [
      ["Your {wordDoc} has run out", "Tu {wordDoc} venció"],
      ["Your {wordDoc} ends today", "Tu {wordDoc} vence hoy"],
      ["Your {wordDoc} ends tomorrow", "Tu {wordDoc} vence mañana"],
      ["Your {wordDoc} ends in {days} days", "Tu {wordDoc} vence en {days} días"],
    ],
    bodies: [
      ["It ended {date}. Send us the new one under My paperwork.", "Venció el {date}. Envíanos el documento nuevo en Mis documentos."],
      ["It ends {date}. Send us the new one under My paperwork.", "Vence el {date}. Envíanos el documento nuevo en Mis documentos."],
    ],
  },

  // A crew lead's crew's machines
  {
    kind: "equipment",
    from: ["public.emit_equipment_alerts"],
    titles: [
      ["{plan} is overdue on {machine}", "{plan} está atrasado en {machine}"],
      ["{plan} is coming due on {machine}", "{plan} ya casi toca en {machine}"],
    ],
    bodies: [
      ["Due {date} or at {reading} {wordMeter} (now {now})", "Toca el {date} o al llegar a {reading} {wordMeter} (ahora {now})"],
      ["Due {date} or at {reading} {wordMeter}", "Toca el {date} o al llegar a {reading} {wordMeter}"],
      ["Due at {reading} {wordMeter} (now {now})", "Toca al llegar a {reading} {wordMeter} (ahora {now})"],
      ["Due at {reading} {wordMeter}", "Toca al llegar a {reading} {wordMeter}"],
      ["Due {date}", "Toca el {date}"],
    ],
  },

  // A client asking to move or cancel, told to the crew lead. Their reason and message are theirs: as written.
  {
    kind: "client",
    from: ["private.visit_change_requested"],
    titles: [
      ["{client} asked to cancel {title}", "{client} pidió cancelar {title}"],
      ["{client} asked to move {title}", "{client} pidió mover {title}"],
    ],
    bodies: [
      ["Booked {when}. No reason given.", "Programada el {when}. No dio motivo."],
      ["Booked {when}. Reason: {reason}", "Programada el {when}. Motivo: {reason}"],
      ["Booked {when}. Asked for {when2}.", "Programada el {when}. Pidió el {when2}."],
      ["Booked {when}. {message}", "Programada el {when}. {message}"],
    ],
  },
];

/** Words the database drops into those sentences (private.sub_document_words, equipment meters). */
export const NOTICE_WORDS: Record<string, string> = {
  "W-9": "W-9",
  "liability insurance": "seguro de responsabilidad civil",
  "workers' comp certificate": "certificado de compensación laboral",
  "workers' comp exemption": "exención de compensación laboral",
  license: "licencia",
  document: "documento",
  hours: "horas",
  miles: "millas",
  // What a time entry is marked as (private.time_entry_changed)
  "a visit": "visita",
  "an assessment": "evaluación",
  driving: "manejo",
  "shop time": "tiempo en el taller",
  "a break": "descanso",
  "other work": "otro trabajo",
};
