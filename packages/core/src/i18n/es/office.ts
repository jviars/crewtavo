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
} satisfies Catalog;
