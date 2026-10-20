Screenshots on the Apps pages, like an app store listing's (features/apps/screenshots.ts). Each has a
light and a dark copy, shown with the app's theme.

The website analytics ones are Marketing's Website tab (features/marketing/WebsiteSection.tsx) with
made-up visits to a lawn care business's website over 30 days, rendered at 1440×900 in light and
dark with Playwright and saved as WebP by Chromium.

The team chat ones are the real chat screen (features/chat/ChatPage.tsx) with made-up people and
messages for a lawn care business, rendered at 1440×900 and saved as WebP. To retake them after the
chat screen changes, render it with sample data and screenshot it with Playwright in both themes.
