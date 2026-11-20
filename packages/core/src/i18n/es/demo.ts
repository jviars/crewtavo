/**
 * The public demo's own screens (apps/web/src/features/demo): the start screen that asks what
 * trade the visitor is in, the bar above the app and the guided tour. A visitor who picks Español
 * on the start screen sees them in Spanish, and the app after it in Spanish as far as it goes.
 * GLOSSARY.md has the words.
 */
import type { Catalog } from "../index";

export default {
  // The start screen
  "Live demo": "Demo en vivo",
  "Try Crewtavo": "Prueba Crewtavo",
  "What kind of work do you do?": "¿Qué tipo de trabajo haces?",
  "You'll get your own sample business in that trade, with clients, quotes, a week of jobs and invoices, to change however you like.":
    "Tendrás tu propio negocio de ejemplo en ese oficio, con clientes, cotizaciones, una semana de trabajos y facturas, para cambiar como quieras.",
  "That demo has ended: demos are deleted after a day. Pick a trade and you'll get a fresh sample business to change however you like.":
    "Esa demo terminó: las demos se borran después de un día. Elige un oficio y tendrás un negocio de ejemplo nuevo para cambiar como quieras.",
  "Your trade::Something else": "Otro oficio",
  "One more step: tick the box to show you're not a robot, and your {trade} demo starts.":
    "Un paso más: marca la casilla para mostrar que no eres un robot, y empieza tu demo de {trade}.",
  "Your crew's screens are in Spanish; the office's are still in English.": "Las pantallas de tu cuadrilla están en español; las de la oficina siguen en inglés.",
  "Photo: {credit}": "Foto: {credit}",
  "Rocky Mount, Virginia · You're {name}, the owner": "Rocky Mount, Virginia · Eres {name}, el dueño",
  "{first}, {second} and {count} more": "{first}, {second} y {count} más",
  "You start as <b>{name}</b>, the owner.": "Empiezas como <b>{name}</b>, el dueño.",
  "<b>Crew's phone</b> shows the day as {lead}, the crew lead.": "<b>Teléfono de la cuadrilla</b> muestra el día como {lead}, el jefe de cuadrilla.",
  "<b>Client's view</b> opens {client}'s portal, with a quote to approve.": "<b>Vista del cliente</b> abre el portal de {client}, con una cotización para aprobar.",

  // What's in each sample business, beside its photo (crew names are the business's own, so they stay).
  "Mow crew, led by {lead}, and the Enhancements crew": "Mow crew, con {lead} al frente, y Enhancements crew",
  "Weekly mowing routes, filled in all season": "Rutas de corte semanales para toda la temporada",
  "A fertilizer program quote waiting on {client}": "Una cotización de fertilización esperando a {client}",
  "New requests from the website form and a phone call": "Solicitudes nuevas del formulario web y de una llamada",
  "Snow removal installed, with a storm already plowed": "Remoción de nieve instalada, con una tormenta ya atendida",
  "Invoices paid by card, check and bank, one overdue": "Facturas pagadas con tarjeta, cheque y banco, una vencida",
  "Install crew, led by {lead}, and the Repair and gutter crew": "Install crew, con {lead} al frente, y Repair and gutter crew",
  "A storm claim, measured on the aerial and quoted": "Un reclamo por tormenta, medido en la vista aérea y cotizado",
  "A new roof for a builder, with 10% retainage": "Un techo nuevo para un constructor, con 10 % de retención",
  "Gutter guards for an HOA clubhouse, still a draft": "Protectores de canaleta para un club, aún en borrador",
  "Crew guides, like the photos for an insurance claim": "Guías para la cuadrilla, como las fotos para el seguro",
  "A deposit invoice, overdue": "Una factura de anticipo, vencida",
  "Paving crew, led by {lead}, and the Sealcoat crew": "Paving crew, con {lead} al frente, y Sealcoat crew",
  "A driveway replacement quote waiting on {client}": "Una cotización para cambiar la entrada de autos, esperando a {client}",
  "A parking lot taken off on the aerial, for sealcoat": "Un estacionamiento medido en la vista aérea, para sellado",
  "Subdivision roads for a builder, with 10% retainage": "Calles para un constructor, con 10 % de retención",
  "A sealcoat and crack repair request by phone": "Una solicitud de sellado y reparación de grietas, por teléfono",
  "A progress invoice for the builder, overdue": "Una factura de avance para el constructor, vencida",
  "Crew 1, led by {lead}, and Crew 2": "Crew 1, con {lead} al frente, y Crew 2",
  "Quotes and jobs from your trade's price list": "Cotizaciones y trabajos con la lista de precios de tu oficio",
  "An estimate request, with a visit today": "Una solicitud de estimado, con visita hoy",
  "A quote waiting on {client}": "Una cotización esperando a {client}",
  "This week's visits on the schedule": "Las visitas de esta semana en la agenda",
  "Invoices paid and one overdue": "Facturas pagadas y una vencida",
  "Lawn care": "Cuidado de césped",
  "Weekly mowing routes, fertilizer programs, cleanups and snow removal.": "Rutas de corte semanales, programas de fertilización, limpiezas y remoción de nieve.",
  "Roofs measured on the aerial, insurance claims and crews on site.": "Techos medidos en la vista aérea, reclamos al seguro y cuadrillas en la obra.",
  "Takeoffs on the aerial, sealcoat and striping, GC work and retainage.": "Mediciones en la vista aérea, sellado y rayado, trabajos para contratistas y retenciones.",
  "Cleaning, HVAC, plumbing, pest control, pools and more.": "Limpieza, climatización, plomería, control de plagas, piscinas y más.",
  "Pick your trade": "Elige tu oficio",
  "Search trades, like plumbing or pool": "Busca oficios, como plomería o piscinas",
  "Search trades": "Buscar oficios",
  "No trade matches. General / Other works for any business.": "Ningún oficio coincide. General / Otro sirve para cualquier negocio.",
  "No sign-up. It's yours alone, and deleted after {hours} hours.": "Sin registro. Es solo tuyo y se borra en {hours} horas.",
  "See it as the owner, as a crew on their phone, and as a client.": "Míralo como dueño, como cuadrilla y como cliente.",
  "Nothing is really emailed or texted, so send away.": "Nada se envía de verdad, así que envía lo que quieras.",
  "By starting a demo you agree to the <terms>Crewtavo Terms</terms>. Ready for your own? <get>Get Crewtavo free</get>":
    "Al empezar una demo aceptas los <terms>Términos de Crewtavo</terms>. ¿Listo para el tuyo? <get>Consigue Crewtavo gratis</get>",
  "Setting up your {trade} business": "Preparando tu negocio de {trade}",
  "Clients, quotes, this week's jobs and invoices, ready to click around in. It takes a few seconds.":
    "Clientes, cotizaciones, los trabajos de esta semana y facturas, listos para explorar. Tarda unos segundos.",

  // Every other trade, as the start screen lists them (the trade presets' names and descriptions)
  "Cleaning & Janitorial": "Limpieza y conserjería",
  "Maid service and house cleaning, deep cleans, move-outs, and office and commercial cleaning.":
    "Limpieza de casas, limpiezas profundas, mudanzas y limpieza de oficinas y comercios.",
  "Electrical": "Electricidad",
  "Service calls, outlets and wiring, lighting, panel upgrades, EV chargers and generator hookups.":
    "Llamadas de servicio, tomacorrientes y cableado, iluminación, cambios de panel, cargadores de autos eléctricos y conexión de generadores.",
  "General / Other": "General / Otro",
  "A simple starting point for any service business.": "Un punto de partida sencillo para cualquier negocio de servicios.",
  "Handyman & Home Repair": "Mantenimiento y reparaciones del hogar",
  "Small repairs, installs, drywall and paint, carpentry and to-do lists, by the hour or the job.":
    "Reparaciones pequeñas, instalaciones, paneles de yeso y pintura, carpintería y listas de pendientes, por hora o por trabajo.",
  "HVAC": "Climatización (HVAC)",
  "Heating and air conditioning: tune-ups, repairs, system installs, ductwork and maintenance plans.":
    "Calefacción y aire acondicionado: puestas a punto, reparaciones, instalación de sistemas, ductos y planes de mantenimiento.",
  "Landscaping & Hardscaping": "Paisajismo y obras exteriores",
  "Landscape design, planting, mulch and sod, patios and walls, irrigation, and bed care plans.":
    "Diseño de jardines, plantación, mantillo y césped en rollo, patios y muros, riego y planes de cuidado de jardineras.",
  "Lawn & Exterior Maintenance": "Césped y mantenimiento exterior",
  "Recurring mowing, seasonal services (leaves, snow, holiday lights), exterior cleaning and commercial grounds plans.":
    "Corte de césped recurrente, servicios de temporada (hojas, nieve, luces navideñas), limpieza exterior y planes para áreas comerciales.",
  "Paving & Sitework": "Pavimento y obra civil",
  "Residential, commercial and municipal paving, sealcoating, striping, grading, stonework, and subcontract work for general contractors.":
    "Pavimento residencial, comercial y municipal, sellado, rayado, nivelación, trabajos en piedra y subcontratos para contratistas generales.",
  "Pest Control": "Control de plagas",
  "Monthly and quarterly pest plans, one-time treatments, termites, rodents, mosquitoes and wildlife.":
    "Planes mensuales y trimestrales, tratamientos únicos, termitas, roedores, mosquitos y fauna silvestre.",
  "Plumbing": "Plomería",
  "Repairs, drains and sewer lines, water heaters, fixtures and repipes for homes and businesses.":
    "Reparaciones, desagües y drenajes, calentadores de agua, accesorios y cambio de tuberías para casas y negocios.",
  "Pool & Spa Service": "Piscinas y spas",
  "Weekly pool service plans, openings and closings, green-pool cleanups, repairs and equipment.":
    "Planes semanales de mantenimiento de piscinas, aperturas y cierres, limpieza de piscinas verdes, reparaciones y equipos.",
  "Roofing & Exteriors": "Techos y exteriores",
  "Shingle and metal roofing, repairs, gutters, siding, windows and decks, with insurance claim details on quotes and jobs.":
    "Techos de tejas y de metal, reparaciones, canaletas, revestimiento, ventanas y terrazas, con los datos del reclamo al seguro en cotizaciones y trabajos.",

  // The bar above the app
  "Demo": "Demo",
  "You're <b>{name}</b>, the owner.": "Eres <b>{name}</b>, el dueño.",
  "You're <b>{name}</b>, the crew lead.": "Eres <b>{name}</b>, el jefe de cuadrilla.",
  "Deleted in about {hours} hours.": "Se borra en unas {hours} horas.",
  "Deleted in about an hour.": "Se borra en una hora, más o menos.",
  "Deleted in under an hour.": "Se borra en menos de una hora.",
  "Tour": "Recorrido",
  "A one-minute tour of your sample business": "Un recorrido de un minuto por tu negocio de ejemplo",
  "Crew's phone": "Teléfono de la cuadrilla",
  "See it as the crew lead, on their phone": "Míralo como el jefe de cuadrilla, en su teléfono",
  "Client's view": "Vista del cliente",
  "Open a client's portal, as they see it": "Abre el portal de un cliente, como él lo ve",
  "Owner's view": "Vista del dueño",
  "Back to the owner": "Volver al dueño",
  "Start over": "Empezar de nuevo",
  "Delete this business and pick a trade again": "Borra este negocio y elige un oficio otra vez",
  "Get Crewtavo": "Consigue Crewtavo",
  "Get Crewtavo free::free": "gratis",
  "Get Crewtavo free": "Consigue Crewtavo gratis",
  "Add a client first, then open their portal from the client's page.": "Agrega un cliente primero y luego abre su portal desde la página del cliente.",

  // The guided tour
  "Guided tour": "Recorrido guiado",
  "{step} of {steps}": "{step} de {steps}",
  "End the tour": "Terminar el recorrido",
  "I'll look around myself": "Exploraré por mi cuenta",
  "Show me around": "Muéstrame",
  "Keep exploring": "Seguir explorando",
  "Back": "Atrás",
  "Welcome to {business}": "Bienvenido a {business}",
  "This is your own sample business, with clients, this week's work, quotes and invoices. Take a one-minute tour, or click around on your own. Nothing you do here reaches anyone.":
    "Este es tu propio negocio de ejemplo, con clientes, el trabajo de esta semana, cotizaciones y facturas. Haz un recorrido de un minuto o explora por tu cuenta. Nada de lo que hagas aquí le llega a nadie.",
  "Your day at a glance": "Tu día de un vistazo",
  "Home shows today's visits, and every request, quote, job and invoice in one row, with what needs you first.":
    "Inicio muestra las visitas de hoy, y cada solicitud, cotización, trabajo y factura en una fila, con lo que te necesita primero.",
  "Work coming in": "Trabajo que llega",
  "Requests arrive from your website's booking form, a phone call or a client's portal, and turn into an estimate visit or a quote.":
    "Las solicitudes llegan del formulario de reservas de tu sitio web, de una llamada o del portal de un cliente, y se convierten en una visita de estimado o una cotización.",
  "The week's work": "El trabajo de la semana",
  "Every visit by crew, with recurring work filled in by itself. Drag a visit to move it, and Map lays out the day's route.":
    "Cada visita por cuadrilla, con el trabajo recurrente agregado solo. Arrastra una visita para moverla, y Mapa traza la ruta del día.",
  "A quote waiting on Jordan": "Una cotización esperando a Jordan",
  "Jordan approves it from a link, picks any optional lines, and it becomes a job with its visits. Measure a yard, roof or lot on the aerial and a quote fills itself in.":
    "Jordan la aprueba desde un enlace, elige las líneas opcionales que quiera y se convierte en un trabajo con sus visitas. Mide un jardín, un techo o un estacionamiento en la vista aérea y la cotización se llena sola.",
  "Getting paid": "Cobrar",
  "Overdue invoices stand out, and Crewtavo can remind clients by itself. Payments come by card, bank or check.":
    "Las facturas vencidas resaltan, y Crewtavo puede recordarles a los clientes por su cuenta. Los pagos llegan con tarjeta, banco o cheque.",
  "Apps for your trade": "Aplicaciones para tu oficio",
  "What your trade needs turns on here: snow removal, paving takeoffs, roofing, a website, team chat and more, along with payments, texting, accounting and calendars. In the demo, the ones that connect outside accounts are off.":
    "Lo que tu oficio necesita se activa aquí: remoción de nieve, mediciones de pavimento, techos, un sitio web, chat del equipo y más, junto con pagos, mensajes de texto, contabilidad y calendarios. En la demo, las que conectan cuentas externas están desactivadas.",
  "Your crew's phone": "El teléfono de tu cuadrilla",
  "Press Crew's phone to see today as Marcus, the crew lead: clock in, the day's stops with directions, checklists and photos. Owner's view brings you back here.":
    "Presiona Teléfono de la cuadrilla para ver el día como Marcus, el jefe de cuadrilla: marcar entrada, las paradas del día con indicaciones, listas de verificación y fotos. Vista del dueño te trae de vuelta aquí.",
  "What your clients see": "Lo que ven tus clientes",
  "Client's view opens a client's portal: a quote to approve, the next visit, invoices to pay by card or bank, and a button to ask for more work.":
    "Vista del cliente abre el portal de un cliente: una cotización para aprobar, la próxima visita, facturas para pagar con tarjeta o banco, y un botón para pedir más trabajo.",
  "That's the tour": "Ese es el recorrido",
  "Now change anything: add a client, send a quote, move a visit, take a payment. It's yours for 24 hours. When you're ready, Crewtavo is free for your own business.":
    "Ahora cambia lo que quieras: agrega un cliente, envía una cotización, mueve una visita, registra un pago. Es tuyo por 24 horas. Cuando estés listo, Crewtavo es gratis para tu propio negocio.",
} satisfies Catalog;
