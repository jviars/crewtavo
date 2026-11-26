/**
 * The office's screens, as they're translated: Apps (Quo and Twilio), Messages, a client's timeline
 * and the setup checklist. Most of the office is still English (docs/spanish-support-plan.md); these
 * are its newer lines, written through t() as they were added. GLOSSARY.md first.
 */
import type { Catalog } from "../index";

export default {
  // Calls on a client's timeline and in Messages (features/clients/callWords.ts, CallNotes.tsx, Timeline.tsx)
  "Next steps": "Próximos pasos",
  "Text sent from Quo to {name}": "Mensaje enviado desde Quo a {name}",
  "Text sent from Quo": "Mensaje enviado desde Quo",
  "Brought in from Quo's history": "Traído del historial de Quo",
  "From Quo": "De Quo",
  "Call to {name}, not answered": "Llamada a {name}, sin contestar",
  "Call not answered": "Llamada sin contestar",
  "Missed call from {name}": "Llamada perdida de {name}",
  "Missed call": "Llamada perdida",
  "Left a voicemail for {name}": "Mensaje de voz para {name}",
  "Left a voicemail": "Se dejó un mensaje de voz",
  "Voicemail from {name}": "Mensaje de voz de {name}",
  "Voicemail": "Mensaje de voz",
  "Call to {name}": "Llamada a {name}",
  "Call with {name}": "Llamada con {name}",
  "noun::Call": "Llamada",
  "details::Show all": "Mostrar todo",
  "Show less": "Mostrar menos",

  // Messages (features/messages)
  "Calls": "Llamadas",
  "Texts and calls deleted": "Mensajes y llamadas eliminados",
  "Calls deleted": "Llamadas eliminadas",
  "Delete these texts and calls": "Eliminar estos mensajes y llamadas",
  "Delete these calls": "Eliminar estas llamadas",
  "Delete the texts and calls from {number}?": "¿Eliminar los mensajes y las llamadas de {number}?",
  "Delete the calls from {number}?": "¿Eliminar las llamadas de {number}?",
  "They're removed for good. If the number texts or calls again, it shows up here again.": "Se eliminan para siempre. Si el número vuelve a escribir o llamar, aparece aquí otra vez.",
  "Its {count} calls move onto the client's timeline, and new texts and calls go there from now on.": { one: "Su llamada pasa al historial del cliente, y los mensajes y llamadas nuevos van ahí desde ahora.", other: "Sus {count} llamadas pasan al historial del cliente, y los mensajes y llamadas nuevos van ahí desde ahora." },
  "Its {texts} and {calls} move onto the client's timeline, and new ones go there from now on.": "Sus {texts} y {calls} pasan al historial del cliente, y los nuevos van ahí desde ahora.",

  // Texts and calls, counted (features/messages/unknownTexts.ts, features/apps/quo.ts)
  "{count} texts": { one: "{count} mensaje", other: "{count} mensajes" },
  "{count} calls": { one: "{count} llamada", other: "{count} llamadas" },

  // Uninstalling Quo (features/apps/AppDetailPage.tsx)
  "Texts stop going out from your Quo number, and go out through your Twilio account again.": "Los mensajes dejan de salir de tu número de Quo y vuelven a salir por tu cuenta de Twilio.",
  "Texts stop going out from your Quo number.": "Los mensajes dejan de salir de tu número de Quo.",
  "Your API key is removed from Crewtavo, and the webhook Crewtavo made in Quo is taken out. Nothing already on clients' timelines is deleted, and nothing else in Quo changes. You can install it again any time.": "Tu clave de API se quita de Crewtavo, y el webhook que Crewtavo creó en Quo se elimina. No se borra nada de lo que ya está en el historial de los clientes, y nada más cambia en Quo. Puedes instalarla de nuevo cuando quieras.",

  // Uninstalling Twilio (features/apps/AppDetailPage.tsx)
  "Texts keep going out from your Quo number, and your Twilio account's keys are removed from Crewtavo. Nothing already sent is deleted, and your Twilio account isn't changed. You can install it again any time.": "Los mensajes siguen saliendo de tu número de Quo, y las claves de tu cuenta de Twilio se quitan de Crewtavo. No se borra nada de lo que ya se envió, y tu cuenta de Twilio no cambia. Puedes instalarla de nuevo cuando quieras.",
  "Texts stop going out from your number, and your Twilio account's keys are removed from Crewtavo. Nothing already sent is deleted, and your Twilio account isn't changed. You can install it again any time.": "Los mensajes dejan de salir de tu número, y las claves de tu cuenta de Twilio se quitan de Crewtavo. No se borra nada de lo que ya se envió, y tu cuenta de Twilio no cambia. Puedes instalarla de nuevo cuando quieras.",

  // Quo's app page (features/apps/QuoPanel.tsx)
  "Your Quo numbers": "Tus números de Quo",
  "Texts go from it now": "Los mensajes salen de este ahora",
  "Quo connected. Replies and calls need one more thing: see below.": "Quo conectado. Las respuestas y las llamadas necesitan un paso más: míralo abajo.",
  "Quo connected": "Quo conectado",
  "Use a different Quo API key": "Usar otra clave de API de Quo",
  "Connect your Quo number": "Conecta tu número de Quo",
  "Your texts go out through Twilio now": "Tus mensajes salen por Twilio ahora",
  "Once Quo is connected, they go out from your Quo number instead. If you disconnect Quo later, Twilio takes over again.": "Cuando Quo esté conectado, saldrán de tu número de Quo. Si luego desconectas Quo, Twilio vuelve a encargarse.",
  "About five minutes. Quo charges for texts sent through its API from your workspace's prepaid credits, about a cent a segment. To text US numbers, Quo has your business registered for US texting (A2P 10DLC) first; that's done in Quo, not here.": "Unos cinco minutos. Quo cobra los mensajes enviados por su API de los créditos prepagados de tu espacio de trabajo, más o menos un centavo por segmento. Para enviar mensajes a números de EE. UU., Quo primero registra tu negocio para mensajes en EE. UU. (A2P 10DLC); eso se hace en Quo, no aquí.",
  "In Quo, open <b>Workspace Settings → API</b> and click <b>Generate API key</b>. A workspace owner or admin can. Name it so you'll know it later, like crewtavo.": "En Quo, abre <b>Workspace Settings → API</b> y haz clic en <b>Generate API key</b>. Lo puede hacer un dueño o administrador del espacio de trabajo. Ponle un nombre que reconozcas después, como crewtavo.",
  "Copy the key, paste it here and check it. Crewtavo asks Quo for your numbers, at no cost.": "Copia la clave, pégala aquí y revísala. Crewtavo le pide a Quo tus números, sin costo.",
  "Quo API key": "Clave de API de Quo",
  "Kept encrypted and never shown again.": "Se guarda cifrada y no se vuelve a mostrar.",
  "Hide key": "Ocultar clave",
  "Show key": "Mostrar clave",
  "Check key": "Revisar clave",
  "Pick the number to text from, and connect.": "Elige el número desde el que se envían los mensajes y conéctalo.",
  "Connect": "Conectar",
  "Texts go out from that number now": "Los mensajes salen de ese número ahora",
  "Quo number": "Número de Quo",
  "Change number": "Cambiar número",
  "Quo isn't accepting this API key anymore": "Quo ya no acepta esta clave de API",
  "Use a different API key": "Usar otra clave de API",
  "Pick the number to text from": "Elige el número desde el que se envían los mensajes",
  "Replies and calls come from the new number from then on. What's already on clients' timelines stays.": "Desde entonces, las respuestas y las llamadas llegan del número nuevo. Lo que ya está en el historial de los clientes se queda.",
  "Use this number": "Usar este número",
  "Change the number or the API key once the past texts and calls are in.": "Cambia el número o la clave de API cuando hayan llegado los mensajes y las llamadas anteriores.",
  "Texts go from": "Los mensajes salen de",
  "Reminders, on-my-way texts and the texts you send from Messages go out from this number, and show in your Quo inbox.": "Los recordatorios, los avisos de en camino y los mensajes que envías desde Mensajes salen de este número y aparecen en tu bandeja de Quo.",
  "Quo sends replies and calls here now": "Quo ya manda aquí las respuestas y las llamadas",
  "Waiting for Quo…": "Esperando a Quo…",
  "Replies and calls": "Respuestas y llamadas",
  "Quo only sends replies and calls to a public https address, and this Crewtavo doesn't have one yet. Texts still go out from your Quo number.": "Quo solo manda respuestas y llamadas a una dirección https pública, y este Crewtavo todavía no tiene una. Los mensajes siguen saliendo de tu número de Quo.",
  "Replies and calls can't come in yet": "Las respuestas y las llamadas todavía no pueden llegar",
  "This Crewtavo's address changed": "La dirección de este Crewtavo cambió",
  "Quo still sends replies and calls to the old one. Update it in Quo to have them come here.": "Quo sigue mandando las respuestas y las llamadas a la anterior. Actualízala en Quo para que lleguen aquí.",
  "Update in Quo": "Actualizar en Quo",
  "Quo isn't sending replies and calls here yet.": "Quo todavía no manda aquí las respuestas y las llamadas.",
  "Set it up in Quo": "Configurarlo en Quo",
  "Replies, texts sent from the Quo app and calls come in. Last heard from Quo {when}.": "Llegan las respuestas, los mensajes enviados desde la aplicación de Quo y las llamadas. Lo último de Quo llegó {when}.",
  "Replies and texts sent from the Quo app come in. Last heard from Quo {when}.": "Llegan las respuestas y los mensajes enviados desde la aplicación de Quo. Lo último de Quo llegó {when}.",
  "Set up in Quo. Nothing has come in through it yet: send a test to see that it gets through.": "Configurado en Quo. Todavía no ha llegado nada: envía una prueba para ver que llega.",
  "Quo's test arrived. Replies and calls come in here.": "Llegó la prueba de Quo. Las respuestas y las llamadas llegan aquí.",
  "Quo's test didn't arrive in 30 seconds": "La prueba de Quo no llegó en 30 segundos",
  "Quo may still be trying. Send another in a minute, or set it up in Quo again.": "Puede que Quo siga intentándolo. Envía otra en un minuto, o configúralo otra vez en Quo.",
  "Set it up again": "Configurarlo otra vez",
  "The address Quo sends to": "La dirección a la que manda Quo",
  "Address for Quo's deliveries": "Dirección para lo que manda Quo",
  "Crewtavo sets this up in Quo for you, as a webhook named Crewtavo under <b>Settings → Webhooks</b>. Don't add it there yourself: Quo signs what it sends with a key only the webhook Crewtavo made knows.": "Crewtavo lo configura en Quo por ti, como un webhook llamado Crewtavo en <b>Settings → Webhooks</b>. No lo agregues tú ahí: Quo firma lo que manda con una clave que solo conoce el webhook que creó Crewtavo.",
  "Calls and your Quo inbox": "Llamadas y tu bandeja de Quo",
  "Put calls on client timelines": "Poner las llamadas en el historial de los clientes",
  "Answered and missed calls and voicemails on your Quo number, with Quo's summary, next steps and the voicemail's words when your Quo plan has them. Calls from numbers that aren't clients wait under <link>Unknown numbers</link> in Messages.": "Las llamadas contestadas y perdidas y los mensajes de voz de tu número de Quo, con el resumen de Quo, los próximos pasos y las palabras del mensaje de voz cuando tu plan de Quo los incluye. Las llamadas de números que no son de clientes esperan en <link>Números desconocidos</link> en Mensajes.",
  "Keep automatic texts out of your Quo inbox": "Mantener los mensajes automáticos fuera de tu bandeja de Quo",
  "Reminders, on-my-way texts and other texts Crewtavo sends by itself go to Quo's Done view, unless the person texted you in the last 3 days, so a question waiting for an answer stays in your inbox. A reply reopens the conversation.": "Los recordatorios, los avisos de en camino y otros mensajes que Crewtavo envía solo van a la vista Done de Quo, salvo que la persona te haya escrito en los últimos 3 días, para que una pregunta que espera respuesta se quede en tu bandeja. Una respuesta vuelve a abrir la conversación.",
  "Bring in past texts and calls": "Traer mensajes y llamadas anteriores",
  "Texts and calls from your Quo number's history go on the timelines of the clients they were with. Nobody is texted, and it's safe to run again: nothing is added twice.": "Los mensajes y las llamadas del historial de tu número de Quo van al historial de los clientes con los que fueron. No se le envía nada a nadie, y puedes hacerlo otra vez sin problema: nada se agrega dos veces.",
  "Bringing them in…": "Trayéndolos…",
  "How far back": "Desde cuándo",
  "Last 3 months": "Últimos 3 meses",
  "Last 12 months": "Últimos 12 meses",
  "Everything Quo has": "Todo lo que tiene Quo",
  "Bring in again": "Traer otra vez",
  "Bring them in": "Traerlos",
  "Done {when}.": "Listo {when}.",
  "Done.": "Listo.",
  "It stopped: {problem} Start it again; anything already brought in is kept.": "Se detuvo: {problem} Empiézalo otra vez; lo que ya se trajo se queda.",
  "It stopped partway, as the server restarted. Start it again; anything already brought in is kept.": "Se detuvo a medias porque el servidor se reinició. Empiézalo otra vez; lo que ya se trajo se queda.",
  "something went wrong.": "algo salió mal.",

  // Twilio's app page with Quo connected too (features/apps/TwilioPanel.tsx)
  "Texting through Quo": "Mensajes de texto por Quo",
  "Your texts go through Quo now": "Tus mensajes salen por Quo ahora",
  "While Quo is connected (<link>Apps → Quo</link>), texts go out from your Quo number. If you disconnect Quo, Twilio takes over again.": "Mientras Quo esté conectado (<link>Aplicaciones → Quo</link>), los mensajes salen de tu número de Quo. Si desconectas Quo, Twilio vuelve a encargarse.",

  // Bringing in Quo's history, in numbers (features/apps/quo.ts)
  "{texts} and {calls} so far.": "{texts} y {calls} hasta ahora.",
  "{texts} and {calls} came in.": "Llegaron {texts} y {calls}.",
  "{count} with numbers that aren't clients' were left in Quo.": { one: "1 de un número que no es de un cliente se quedó en Quo.", other: "{count} de números que no son de clientes se quedaron en Quo." },

  // The setup checklist (features/home/SetupCard.tsx)
  "Reminders and on-my-way texts from your own number, with Quo or your Twilio account.": "Recordatorios y avisos de en camino desde tu propio número, con Quo o tu cuenta de Twilio.",
  "Connect Quo or Twilio": "Conectar Quo o Twilio",

  // Turning texting on (features/settings/ConnectEmailHint.tsx)
  "Connect <quo>Quo</quo> or <twilio>Twilio</twilio> {then}.": "Conecta <quo>Quo</quo> o <twilio>Twilio</twilio> {then}.",
  "An owner can turn it on in Apps → Quo or Apps → Twilio.": "Un dueño puede activarlo en Aplicaciones → Quo o Aplicaciones → Twilio.",
} satisfies Catalog;
