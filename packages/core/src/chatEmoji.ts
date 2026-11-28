/**
 * Reactions in team chat: the three quick ones people tap most (thumbs up, "On it", "Seen", core
 * chat.ts CHAT_REACTIONS), and any emoji from this curated list, grouped as the picker shows them.
 * The words after each emoji are what a search in the picker finds it by; they're never shown, so
 * they aren't translated. The database allows exactly these (private.chat_reaction_emoji(),
 * supabase/migrations/20261129102100_chat_reaction_emoji.sql), and a test keeps the two the same.
 */
import { CHAT_REACTIONS } from "./chat";
import { msg } from "./i18n";

export const CHAT_EMOJI_GROUPS = [
  { key: "smileys", label: msg("Smileys"), icon: "😀" },
  { key: "people", label: msg("People and hands"), icon: "👋" },
  { key: "work", label: msg("Work and tools"), icon: "🔨" },
  { key: "nature", label: msg("Nature and weather"), icon: "🌿" },
  { key: "food", label: msg("Food"), icon: "🍔" },
  { key: "travel", label: msg("Travel and vehicles"), icon: "🚚" },
  { key: "objects", label: msg("Objects"), icon: "💡" },
  { key: "symbols", label: msg("Symbols"), icon: "❤️" },
] as const;
export type ChatEmojiGroup = (typeof CHAT_EMOJI_GROUPS)[number]["key"];

// One emoji a line, then the words it's found by.
const LISTS: Record<ChatEmojiGroup, string> = {
  smileys: `
😀 grinning smile happy
😃 smiley happy joy
😄 smile happy laugh
😁 grin beaming
😆 laughing lol
😅 sweat smile relief phew
😂 joy tears laughing lol funny
🤣 rofl rolling laughing funny
🙂 slight smile ok
🙃 upside down silly
😉 wink
😊 blush smile happy
😇 innocent halo angel
🥰 love hearts adore
😍 heart eyes love
🤩 star struck wow amazing
😘 kiss blow
😋 yum tasty delicious
😛 tongue
😜 wink tongue crazy
🤪 zany crazy goofy
🤑 money mouth rich
🤗 hug hugging
🤭 oops giggle hand over mouth
🤫 shush quiet secret
🤔 thinking hmm wonder
🤐 zipper mouth secret
🤨 raised eyebrow skeptical
😐 neutral meh
😑 expressionless blank
😶 no mouth silent speechless
😏 smirk
😒 unamused
🙄 eye roll
😬 grimace awkward yikes
😮‍💨 exhale relief sigh phew
😌 relieved calm
😔 pensive sad
😪 sleepy
🤤 drool
😴 sleeping tired zzz
😷 mask sick
🤒 sick fever thermometer
🤕 hurt injured bandage
🤢 nauseated sick
🤮 vomit sick
🥵 hot heat sweating
🥶 cold freezing
🥴 woozy dizzy
😵 dizzy knocked out
🤯 mind blown exploding head
🤠 cowboy yeehaw
🥳 party celebrate birthday
😎 cool sunglasses
🤓 nerd glasses
🧐 monocle inspect
😕 confused
😟 worried
🙁 frown sad
😮 open mouth wow surprised
😯 hushed surprised
😲 astonished shocked
😳 flushed embarrassed
🥺 pleading puppy eyes please
😦 frowning
😧 anguished
😨 fearful scared
😰 anxious sweat nervous
😥 sad disappointed relieved
😢 cry tear sad
😭 sob crying
😱 scream scared horror
😖 confounded
😣 persevere struggle
😞 disappointed
😓 downcast sweat
😩 weary tired
😫 tired exhausted
🥱 yawn bored tired
😤 triumph huff steam
😠 angry mad
😡 angry mad pouting rage
🤬 cursing swearing
😈 devil smiling
💀 skull dead
💩 poop
🤡 clown
👻 ghost boo
👽 alien
🤖 robot
`,
  people: `
👋 wave hello hi bye
🤚 raised back of hand
✋ raised hand stop high five
🖐️ hand fingers splayed
👌 ok okay perfect
🤌 pinched fingers
🤏 pinching small little
✌️ victory peace
🤞 fingers crossed luck hope
🤟 love you gesture
🤘 rock on horns
🤙 call me shaka
👈 point left
👉 point right
👆 point up
👇 point down
☝️ index up one
👍 thumbs up yes like good agree
👎 thumbs down no dislike bad
✊ raised fist
👊 fist bump punch
🤛 left fist bump
🤜 right fist bump
👏 clap applause bravo
🙌 raising hands hooray celebrate
👐 open hands
🤲 palms up
🤝 handshake deal agree
🙏 pray please thanks thank you
✍️ writing
💪 muscle strong flex biceps
🦾 mechanical arm
🧠 brain smart think
👀 eyes look see watching
👁️ eye
👂 ear listen hear
👃 nose smell
🫡 salute yes sir
🙋 raising hand me volunteer
🙅 no gesture
🙆 ok gesture
🤷 shrug dunno whatever
🤦 facepalm
💁 tipping hand info
🙇 bow sorry
🧑‍🔧 mechanic repair
👷 construction worker builder hard hat
🧑‍🌾 farmer gardener landscaper
🧑‍💼 office worker
🧑‍🏭 factory worker welder
🧑‍🚒 firefighter
👮 police officer
🧑‍⚕️ health worker doctor nurse
🏃 running hurry late
🚶 walking
🧍 standing
👶 baby
🧒 child kid
🧑 person adult
🧓 older person
`,
  work: `
🔨 hammer
🪓 axe
⛏️ pick mining
⚒️ hammer and pick
🛠️ tools hammer wrench repair
🔧 wrench spanner
🪛 screwdriver
🔩 nut bolt
⚙️ gear cog settings
🧰 toolbox
🪚 saw carpentry
📏 ruler straight measure
📐 triangle ruler measure angle
🧱 brick wall masonry
🪜 ladder
🦺 safety vest hi vis
⛑️ helmet rescue hard hat
🧯 fire extinguisher
🔌 plug electric power
💡 light bulb idea
🔦 flashlight torch
🪣 bucket
🧹 broom sweep clean
🧽 sponge clean
🧪 test tube chemical
🔋 battery charge
🪫 low battery
⛽ fuel gas pump diesel
🚧 construction barrier road work
⚠️ warning caution
🚨 siren alert emergency
📋 clipboard checklist
📝 memo note write
✏️ pencil
🖊️ pen
📎 paperclip attach
📌 pushpin pin
📍 round pin location map address
🗂️ dividers files
📁 folder
📄 page document
📊 chart bar stats
📈 chart up growth increase
📉 chart down decrease
📅 calendar date
🗓️ spiral calendar schedule
⏰ alarm clock time
⏱️ stopwatch timer
⌛ hourglass waiting
💼 briefcase work business
🧾 receipt
💵 dollar cash money
💰 money bag
💳 credit card payment
🏦 bank
📦 package box delivery
🏷️ label tag price
🔑 key
🔒 locked lock
🔓 unlocked open
📞 telephone phone call
📱 mobile phone cell
💻 laptop computer
🖨️ printer print
📷 camera photo
📸 camera flash picture
🔍 magnifying glass search look
`,
  nature: `
☀️ sun sunny
🌤️ sun small cloud
⛅ partly cloudy
🌥️ sun behind cloud
☁️ cloud cloudy
🌦️ sun rain showers
🌧️ rain rainy
⛈️ thunderstorm storm
🌩️ lightning storm
🌨️ snow cloud
❄️ snowflake snow cold
☃️ snowman
⛄ snowman
🌬️ wind blowing
💨 dash wind fast
🌪️ tornado
🌫️ fog
🌈 rainbow
☔ umbrella rain
💧 droplet water
💦 splash water sweat
🌊 wave water ocean
🔥 fire hot lit
⚡ lightning bolt zap electric
🌡️ thermometer temperature
🌙 moon night
⭐ star
🌟 glowing star
🌱 seedling sprout grow plant
🌿 herb leaf
☘️ shamrock
🍀 four leaf clover luck
🍃 leaves blowing
🍂 fallen leaf autumn fall
🍁 maple leaf fall autumn
🌾 grain wheat field
🌵 cactus
🌴 palm tree
🌳 tree
🌲 evergreen tree pine
🪵 wood log lumber
🪨 rock stone
🌻 sunflower
🌼 blossom flower
🌸 cherry blossom
🌷 tulip
🌹 rose
💐 bouquet flowers
🍄 mushroom
🐶 dog puppy
🐱 cat
🐭 mouse
🐰 rabbit bunny
🦊 fox
🐻 bear
🐿️ squirrel chipmunk
🦌 deer
🐦 bird
🐝 bee honeybee
🐛 bug caterpillar
🐜 ant
🕷️ spider
🐍 snake
🐢 turtle slow
🐟 fish
🦆 duck
🐓 rooster chicken
🐄 cow
🐴 horse
`,
  food: `
☕ coffee hot drink
🍵 tea
🥤 cup straw soda
🧃 juice box
🧊 ice
🍺 beer
🍻 cheers beers
🥂 champagne toast cheers
🍷 wine
🍕 pizza
🍔 hamburger burger
🌭 hot dog
🌮 taco
🌯 burrito
🥪 sandwich lunch
🥗 salad
🍝 spaghetti pasta
🍜 noodles ramen
🍣 sushi
🍗 chicken leg poultry
🍖 meat bone
🥓 bacon
🍳 cooking egg breakfast
🥞 pancakes
🧇 waffle
🥐 croissant
🥯 bagel
🍞 bread
🧀 cheese
🍟 fries
🍿 popcorn
🍩 doughnut donut
🍪 cookie
🎂 birthday cake
🍰 cake slice
🧁 cupcake
🍫 chocolate
🍬 candy
🍦 ice cream
🍎 apple red
🍏 green apple
🍊 orange tangerine
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🍑 peach
🥑 avocado
🌶️ hot pepper spicy
🥕 carrot
🌽 corn
🥔 potato
🍅 tomato
`,
  travel: `
🚗 car automobile
🚙 suv
🛻 pickup truck
🚚 delivery truck
🚛 semi truck lorry
🚜 tractor
🏎️ race car fast
🚐 van minibus
🚌 bus
🚑 ambulance
🚒 fire engine truck
🚓 police car
🛵 scooter
🏍️ motorcycle
🚲 bicycle bike
🛴 kick scooter
🛞 wheel tire
🚦 traffic light
🛑 stop sign
🛣️ highway road
🗺️ map
🧭 compass direction
⛰️ mountain
🏔️ snow mountain
🏕️ camping
🏖️ beach
🏠 house home
🏡 house garden yard
🏘️ houses neighborhood
🏚️ old house derelict
🏗️ building construction crane
🏢 office building
🏭 factory
🏪 store shop
🏫 school
🏥 hospital
🏨 hotel
⛪ church
🌉 bridge
✈️ airplane flight
🚁 helicopter
🚀 rocket launch fast
⛵ sailboat
🚤 speedboat
⚓ anchor
🅿️ parking
`,
  objects: `
🎉 party popper tada celebrate congrats
🎊 confetti ball
🎈 balloon
🎁 gift present
🏆 trophy win award
🥇 gold medal first
🏅 medal
🎯 bullseye target goal
🎵 music note
🎶 music notes
🎤 microphone sing
🎧 headphones
📢 loudspeaker announcement
📣 megaphone
🔔 bell notification
🔕 bell off mute
📬 mailbox mail
✉️ envelope letter email
📰 newspaper news
📚 books
📖 open book read
🔖 bookmark
🗑️ trash wastebasket
🛒 shopping cart
🪑 chair
🛏️ bed
🚪 door
🪟 window
🚿 shower
🛁 bathtub
🚽 toilet
🧻 toilet paper roll
🧺 basket laundry
🧸 teddy bear
🖼️ framed picture
🕯️ candle
💎 gem diamond
💍 ring
⌚ watch
🕶️ sunglasses
🧢 cap hat
👟 sneaker shoe
🥾 hiking boot work boots
🧤 gloves
🧥 coat jacket
👕 shirt
👖 jeans
🎒 backpack
☂️ umbrella
🧳 luggage suitcase
`,
  symbols: `
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
💔 broken heart
❣️ heart exclamation
💯 hundred 100 perfect
✅ check mark done yes
☑️ ballot box check
✔️ check mark
❌ cross mark x no wrong
❎ cross mark button
➕ plus add
➖ minus
❓ question mark
❗ exclamation important
‼️ double exclamation
⁉️ interrobang
💤 zzz sleep
💥 collision boom
💫 dizzy star
✨ sparkles shiny new
💬 speech balloon comment chat
💭 thought balloon
🗯️ anger bubble
♻️ recycle
🚫 prohibited no
⛔ no entry
⭕ circle
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle go
🔵 blue circle
🟣 purple circle
⚫ black circle
⚪ white circle
🟥 red square
🟩 green square
⬆️ up arrow
⬇️ down arrow
⬅️ left arrow
➡️ right arrow
🔄 arrows repeat refresh
🔁 repeat
⏩ fast forward
▶️ play
⏸️ pause
⏹️ stop
🆗 ok button
🆕 new button
🆘 sos help
💲 dollar sign
1️⃣ one 1 first
2️⃣ two 2 second
3️⃣ three 3 third
🏁 checkered flag finish
🚩 red flag
🏳️ white flag
`,
};

export interface ChatEmoji {
  emoji: string;
  group: ChatEmojiGroup;
  /** What a search finds it by. */
  words: string;
}

/** Every emoji people can react with, in the picker's order. */
export const CHAT_EMOJI: readonly ChatEmoji[] = CHAT_EMOJI_GROUPS.flatMap(({ key }) =>
  LISTS[key]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return { emoji: line.slice(0, space), group: key, words: line.slice(space + 1) };
    }),
);

const EMOJI = new Set(CHAT_EMOJI.map((e) => e.emoji));
const QUICK = new Set<string>(CHAT_REACTIONS.map((r) => r.key));

/** Thumbs up is one of the quick reactions already: picked from the list, it's that one, not a second. */
export const reactionKind = (picked: string): string => (picked === "👍" ? "thumbs_up" : picked);

/** A reaction the database takes: a quick one's key, or an emoji from the list. */
export const isReactionKind = (kind: unknown): kind is string => typeof kind === "string" && (QUICK.has(kind) || (EMOJI.has(kind) && kind !== "👍"));

/** Emoji a search finds: each word typed starts one of an emoji's words. */
export function findEmoji(query: string, list: readonly ChatEmoji[] = CHAT_EMOJI): ChatEmoji[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((e) => {
    const own = e.words.split(" ");
    return words.every((w) => own.some((o) => o.startsWith(w)) || e.emoji === w);
  });
}

/** Reactions in the order they show: the quick ones first, as CHAT_REACTIONS lists them, then the rest as they came. */
export function orderReactions<T extends { kind: string }>(groups: readonly T[]): T[] {
  const quick = CHAT_REACTIONS.flatMap((r) => groups.filter((g) => g.kind === r.key));
  return [...quick, ...groups.filter((g) => !QUICK.has(g.kind))];
}

/** Recently used emoji, newest first, at most `max`: what the picker keeps in the browser. */
export function rememberEmoji(recent: readonly string[], emoji: string, max = 24): string[] {
  return [...new Set([emoji, ...recent])].filter((e) => EMOJI.has(e)).slice(0, max);
}

/** How many reactions one message can have: kinds in all, and one person's. */
export const MAX_REACTION_KINDS = 20;
export const MAX_REACTIONS_EACH = 12;
