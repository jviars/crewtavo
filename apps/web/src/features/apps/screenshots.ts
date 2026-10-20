/** Screenshots on an app's page, like an app store listing's (see assets/apps/screenshots/README.md). */
import announcementsDark from "@/assets/apps/screenshots/team-chat-announcements-dark.webp";
import announcementsLight from "@/assets/apps/screenshots/team-chat-announcements-light.webp";
import crewDark from "@/assets/apps/screenshots/team-chat-crew-dark.webp";
import crewLight from "@/assets/apps/screenshots/team-chat-crew-light.webp";
import findDark from "@/assets/apps/screenshots/fal-find-paving-dark.webp";
import findLight from "@/assets/apps/screenshots/fal-find-paving-light.webp";
import projectDark from "@/assets/apps/screenshots/fal-project-dark.webp";
import projectLight from "@/assets/apps/screenshots/fal-project-light.webp";
import takeoffDark from "@/assets/apps/screenshots/fal-takeoff-dark.webp";
import takeoffLight from "@/assets/apps/screenshots/fal-takeoff-light.webp";

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
  fal: [
    { light: findLight, dark: findDark, alt: "Find paving on the measuring map: asphalt, concrete and stalls, found on the aerial in view" },
    { light: takeoffLight, dark: takeoffDark, alt: "A parking lot takeoff on the aerial: asphalt outlined, stall rows, ADA stalls and crack seal, each in its own color" },
    { light: projectLight, dark: projectDark, alt: "The paving project: the takeoff sheet with its quantities, on the way from estimate to invoice" },
  ],
};
