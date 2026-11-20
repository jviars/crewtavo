/**
 * Error messages a team member can meet on their own screens, by their English shape
 * (patterns.ts): the database's `raise exception` text and the server's HttpError sentences, as
 * the web app shows them (lib/errors.ts), and a few sentences the server sends for the field app to
 * show (a sub's insurance warning, what doesn't add up on a receipt). A message with no line here
 * shows in English. Office-only messages aren't here (docs/spanish-support-plan.md, phase 3).
 */
import type { PatternTable } from "../patterns";

export const ERRORS: PatternTable = [
  // Visits, from the field (private.visit_crew_guard, private.visit_sub_guard, routes/schedule.ts)
  ["You can change a visit's status and notes. Ask the office about anything else.", "Puedes cambiar el estado y las notas de una visita. Pregúntale a la oficina por lo demás."],
  ["You can change your own crew's visits. Ask the office to change this one.", "Puedes cambiar las visitas de tu cuadrilla. Pídele a la oficina que cambie esta."],
  ["You can change your own crew's visits. Ask the office to move this one.", "Puedes cambiar las visitas de tu cuadrilla. Pídele a la oficina que mueva esta."],
  ["Ask the office to cancel, move or reopen this visit.", "Pídele a la oficina que cancele, mueva o vuelva a abrir esta visita."],
  ["Ask the office to cancel or move this visit.", "Pídele a la oficina que cancele o mueva esta visita."],
  ["Your role can't reschedule visits", "Tu rol no puede reprogramar visitas"],
  ["Your role can't move visits.", "Tu rol no puede mover visitas."],
  ["Your role can't reschedule or reassign visits.", "Tu rol no puede reprogramar ni reasignar visitas."],
  ["Your role can't schedule visits.", "Tu rol no puede programar visitas."],
  ["Your role can't schedule the whole team.", "Tu rol no puede programar a todo el equipo."],
  ["You can schedule your own crew's work. Pick your crew.", "Puedes programar el trabajo de tu cuadrilla. Elige tu cuadrilla."],
  ["Pick your crew to move its visits.", "Elige tu cuadrilla para mover sus visitas."],
  ["The visit has to end after it starts.", "La visita tiene que terminar después de empezar."],
  ["That visit wasn't found.", "No se encontró esa visita."],
  ["Visit not found.", "No se encontró la visita."],
  ["Job not found.", "No se encontró el trabajo."],
  ["This visit isn't for a job.", "Esta visita no es de un trabajo."],

  // The clock and logged work (private.time_entry_*, private.job_material_time_guard, private.equipment_log_date_guard)
  ["Only the office can move time to someone else", "Solo la oficina puede pasarle tiempo a otra persona"],
  ["Where someone clocked in or out is saved by the clock as it starts or stops", "El lugar donde alguien marcó entrada o salida lo guarda el reloj al iniciar o parar"],
  ["That time is in the future", "Esa hora todavía no llega"],
  ["That date is in the future", "Esa fecha todavía no llega"],
  ["The office or a crew lead changes when material was logged", "La oficina o un jefe de cuadrilla cambia cuándo se registró el material"],

  // Adding work on a visit (public.add_field_line)
  ["Enter how many.", "Escribe cuántos."],
  ["That item isn't on the price list anymore.", "Eso ya no está en la lista de precios."],
  ["This job is closed. Tell the office about the extra work in the notes.", "Este trabajo está cerrado. Dile a la oficina del trabajo extra en las notas."],
  ["This visit is already invoiced. Tell the office about the extra work in the notes.", "Esta visita ya está facturada. Dile a la oficina del trabajo extra en las notas."],
  ["Some of that work is already on invoice #{number}", "Parte de ese trabajo ya está en la factura #{number}"],

  // A sub's offers (public.answer_sub_offer, services/subOffers.ts, private.sub_offer_warning_words)
  ["Accept it or decline it.", "Acéptalo o recházalo."],
  ["Keep the reason short: 500 characters at most.", "Que el motivo sea corto: 500 caracteres como máximo."],
  ["We can't find that job offer.", "No encontramos esa oferta de trabajo."],
  ["This offer is from another company you work for. Switch to it to answer.", "Esta oferta es de otra empresa con la que trabajas. Cambia a esa empresa para responder."],
  ["We don't have your liability insurance on file. We'll check the new one you sent.", "No tenemos tu seguro de responsabilidad civil. Vamos a revisar el nuevo que enviaste."],
  ["We don't have your workers' comp certificate or exemption on file. We'll check the new one you sent.", "No tenemos tu certificado o exención de compensación laboral. Vamos a revisar el documento nuevo que enviaste."],
  ["We don't have your liability insurance on file.", "No tenemos tu seguro de responsabilidad civil."],
  ["We don't have your workers' comp certificate or exemption on file.", "No tenemos tu certificado o exención de compensación laboral."],
  ["Your {wordDoc} on file has run out. We'll check the new one you sent.", "Tu {wordDoc} que tenemos venció. Vamos a revisar el documento nuevo que enviaste."],
  ["Your {wordDoc} on file has run out.", "Tu {wordDoc} que tenemos venció."],
  ["Your {wordDoc} on file ends before this job. We'll check the new one you sent.", "Tu {wordDoc} que tenemos vence antes de este trabajo. Vamos a revisar el documento nuevo que enviaste."],
  ["Your {wordDoc} on file ends before this job.", "Tu {wordDoc} que tenemos vence antes de este trabajo."],
  ["We haven't checked the {wordDoc} you sent yet.", "Todavía no revisamos tu {wordDoc} que enviaste."],

  // Reading a receipt (routes/receipts.ts, core receipts.ts readingProblems)
  ["No total was found. Enter what it cost.", "No se encontró el total. Escribe cuánto costó."],
  ["The total read isn't more than zero. Check it.", "El total que se leyó no es mayor que cero. Revísalo."],
  ["The lines and tax come to {sum}, not the {total} total. Check them.", "Las líneas y el impuesto suman {sum}, no el total de {total}. Revísalos."],
  ["The lines come to {sum}, not the {total} total. Check them.", "Las líneas suman {sum}, no el total de {total}. Revísalas."],
  ["The subtotal and tax come to {sum}, not the {total} total. Check them.", "El subtotal y el impuesto suman {sum}, no el total de {total}. Revísalos."],
  ["The subtotal come to {sum}, not the {total} total. Check them.", "El subtotal suma {sum}, no el total de {total}. Revísalo."],
  ["Some lines have no price. Check them.", "Algunas líneas no tienen precio. Revísalas."],
  ["Only photos (JPEG, PNG, GIF, WebP) and PDFs can be read. Fill it in by hand.", "Solo se pueden leer fotos (JPEG, PNG, GIF, WebP) y PDF. Llénalo a mano."],
  ["That file is too large to read. Fill it in by hand.", "Ese archivo es demasiado grande para leerlo. Llénalo a mano."],
  ["The AI's answer couldn't be read. Fill it in by hand.", "No se pudo leer la respuesta de la IA. Llénalo a mano."],
  ["The file couldn't be opened. Fill it in by hand.", "No se pudo abrir el archivo. Llénalo a mano."],
  ["This draft is gone: someone may have saved or discarded it already.", "Este borrador ya no está: puede que alguien ya lo haya guardado o descartado."],

  // Uploads and notifications on this phone (routes/storage.ts, routes/push.ts)
  ["That upload has run out. Send the file again.", "Esa subida venció. Envía el archivo otra vez."],
  ["We couldn't get ready for your file. Try again in a minute.", "No pudimos preparar tu archivo. Intenta de nuevo en un minuto."],
  ["Turn on notifications on this phone first.", "Primero activa las notificaciones en este teléfono."],
  ["The phone's push service didn't take it. Turn notifications off and on again.", "El servicio de notificaciones del teléfono no lo aceptó. Desactiva y vuelve a activar las notificaciones."],

  // Team chat (private.chat_message_guard, routes/chat.ts)
  ["Write a message first", "Primero escribe un mensaje"],
  ["Keep it under 2,000 characters.", "Que tenga menos de 2,000 caracteres."],
  ["You can only edit your own messages", "Solo puedes editar tus propios mensajes"],
  ["You can only edit your own messages.", "Solo puedes editar tus propios mensajes."],
  ["You can only delete your own messages", "Solo puedes eliminar tus propios mensajes"],
  ["You can only delete your own messages.", "Solo puedes eliminar tus propios mensajes."],
  ["You can't post in this channel.", "No puedes publicar en este canal."],
  ["That message was deleted", "Ese mensaje se eliminó"],
  ["That message isn't in this channel.", "Ese mensaje no está en este canal."],
  ["Photos and links can't be changed after sending", "Las fotos y los enlaces no se pueden cambiar después de enviarlos"],
  ["Only people who manage this channel can pin messages", "Solo quienes administran este canal pueden fijar mensajes"],
  ["Only people who manage this channel can pin messages.", "Solo quienes administran este canal pueden fijar mensajes."],

  // Guides (public.acknowledge_guide, public.guide_feedback)
  ["Answer the guide's questions first", "Primero responde las preguntas de la guía"],
  ["That guide wasn't found.", "No se encontró esa guía."],
  ["That revision is no longer current; reload the page", "Esa versión ya no es la actual; vuelve a cargar la página"],
  ["Send a vote or a suggestion.", "Envía un voto o una sugerencia."],

  // Sending (services/sales.ts reasons a send didn't go, as the field's Send dialog shows them)
  ["Link only", "Solo enlace"],
  // Why someone can't be ticked for a text in the Send dialog, and why a text wasn't sent (services/textsOff.ts).
  ["Texts off", "Mensajes de texto desactivados"],
  ["{name} asked not to be texted, so texts to them are off. Send it by email instead.", "{name} pidió no recibir mensajes de texto, así que están desactivados. Envíalo por correo."],
  ["{phone} asked not to be texted, so Crewtavo can't text it.", "{phone} pidió no recibir mensajes de texto, así que Crewtavo no puede enviarle."],

  // The public demo (apps/api/src/routes/demo.ts, services/demo.ts, lib/demoMode.ts): a visitor who picked Español.
  ["You've started a lot of demos. Wait a little and try again.", "Empezaste muchas demos. Espera un poco e intenta de nuevo."],
  ["You've started a lot of demos today. Try again tomorrow.", "Empezaste muchas demos hoy. Intenta de nuevo mañana."],
  ["The demo is very busy right now. Try again in a few minutes.", "La demo está muy ocupada ahora. Intenta de nuevo en unos minutos."],
  ["The demo is very busy today. Try again later.", "La demo está muy ocupada hoy. Intenta de nuevo más tarde."],
  ["Agree to the Crewtavo Terms to start the demo.", "Acepta los Términos de Crewtavo para empezar la demo."],
  ["The Crewtavo Terms changed since this page opened. Reload the page and try again.", "Los Términos de Crewtavo cambiaron desde que abriste esta página. Vuelve a cargarla e intenta de nuevo."],
  ["Please complete the check that you're not a robot, then try again.", "Completa la verificación de que no eres un robot e intenta de nuevo."],
  ["Couldn't set up the demo business. Try again in a moment.", "No se pudo preparar el negocio de la demo. Intenta de nuevo en un momento."],
  ["Pick a trade from the list.", "Elige un oficio de la lista."],
  ["That's turned off in the demo, because it would reach outside it. In your own Crewtavo it works here.", "Eso está desactivado en la demo, porque saldría de ella. En tu propio Crewtavo funciona aquí."],
  ["That's a lot of changes at once for the demo. Wait a few minutes and carry on.", "Son muchos cambios a la vez para la demo. Espera unos minutos y sigue."],
  ["This demo has ended. Start a new one.", "Esta demo terminó. Empieza una nueva."],
  ["That's only for the demo's own sign-ins.", "Eso es solo para las cuentas de la demo."],
  ["There's no crew lead in this business any more. Make Marcus one again in Settings → Team, then try again.", "Ya no hay un jefe de cuadrilla en este negocio. Vuelve a hacer jefe a Marcus en Configuración → Equipo e intenta de nuevo."],
  ["There's no owner in this business any more.", "Ya no hay un dueño en este negocio."],
  ["The demo comes with one business. Start a new demo for another trade.", "La demo trae un solo negocio. Empieza una demo nueva para otro oficio."],
  ["Files in the demo can be up to 10 MB.", "En la demo, los archivos pueden ser de hasta 10 MB."],
  ["That's more than the demo takes at once (2 MB).", "Es más de lo que la demo acepta de una vez (2 MB)."],
  ["That's a lot of files for the demo. Try again in an hour.", "Son muchos archivos para la demo. Intenta de nuevo en una hora."],
];
