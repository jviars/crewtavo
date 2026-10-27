Screenshots on the Apps pages, like an app store listing's (features/apps/screenshots.ts). Each has a
light and a dark copy, shown with the app's theme.

The website analytics ones are Marketing's Website tab (features/marketing/WebsiteSection.tsx) with
made-up visits to a lawn care business's website over 30 days, rendered at 1440×900 in light and
dark with Playwright and saved as WebP by Chromium.

The team chat ones are the real chat screen (features/chat/ChatPage.tsx) with made-up people and
messages for a lawn care business, rendered at 1440×900 and saved as WebP. To retake them after the
chat screen changes, render it with sample data and screenshot it with Playwright in both themes.

The Sveltia CMS ones are the real Sveltia CMS (0.248.1) with its test backend, seeded with a made-up
lawn care business's website (Green Valley Lawn Care: blog posts, services, pages, hours), rendered
at 1440×900 in light and dark with Playwright and saved as WebP by Chromium.

The ABC Supply ones are the real Roofing → Catalog with a made-up roofing business (Summit Roofing)
whose ABC Supply connection answered from a local stand-in for ABC's API: a made-up catalog of
shingles, underlayment and trim in ABC's documented shapes, at made-up prices, with no pictures
(so the colors are drawn as swatches). Rendered at 1440×900 in light and dark with Playwright and
saved as WebP by Chromium.

The fal.ai ones are the real measuring map and Paving project page, with a demo paving business's
takeoff of a parking lot in Radford, VA on Virginia's state imagery (VGIN), taken from a local
instance with Playwright at 1440×900 in both themes and saved as WebP from Chromium's canvas.
