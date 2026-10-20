/** Screenshots on an app's page, like an app store listing's (see assets/apps/screenshots/README.md). */
import announcementsDark from "@/assets/apps/screenshots/team-chat-announcements-dark.webp";
import announcementsLight from "@/assets/apps/screenshots/team-chat-announcements-light.webp";
import crewDark from "@/assets/apps/screenshots/team-chat-crew-dark.webp";
import crewLight from "@/assets/apps/screenshots/team-chat-crew-light.webp";

/** One screenshot, in the app's light and dark themes. */
export interface Screenshot {
  light: string;
  dark: string;
  alt: string;
}

export const SCREENSHOTS: Record<string, Screenshot[]> = {
  team_chat: [
    { light: crewLight, dark: crewDark, alt: "A crew's channel: a job linked in a message, an @mention, reactions, and who's online" },
    { light: announcementsLight, dark: announcementsDark, alt: "Announcements: a pinned message to @everyone that the whole team has seen" },
  ],
};
