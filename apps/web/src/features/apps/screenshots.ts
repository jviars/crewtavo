/** Screenshots on an app's page, like an app store listing's (see assets/apps/screenshots/README.md). */
import analyticsSourcesDark from "@/assets/apps/screenshots/website-analytics-sources-dark.webp";
import analyticsSourcesLight from "@/assets/apps/screenshots/website-analytics-sources-light.webp";
import analyticsVisitsDark from "@/assets/apps/screenshots/website-analytics-visits-dark.webp";
import analyticsVisitsLight from "@/assets/apps/screenshots/website-analytics-visits-light.webp";
import announcementsDark from "@/assets/apps/screenshots/team-chat-announcements-dark.webp";
import announcementsLight from "@/assets/apps/screenshots/team-chat-announcements-light.webp";
import crewDark from "@/assets/apps/screenshots/team-chat-crew-dark.webp";
import crewLight from "@/assets/apps/screenshots/team-chat-crew-light.webp";
import sveltiaHoursDark from "@/assets/apps/screenshots/sveltia-hours-dark.webp";
import sveltiaHoursLight from "@/assets/apps/screenshots/sveltia-hours-light.webp";
import sveltiaPostDark from "@/assets/apps/screenshots/sveltia-post-dark.webp";
import sveltiaPostLight from "@/assets/apps/screenshots/sveltia-post-light.webp";
import sveltiaServicesDark from "@/assets/apps/screenshots/sveltia-services-dark.webp";
import sveltiaServicesLight from "@/assets/apps/screenshots/sveltia-services-light.webp";

/** One screenshot, in the app's light and dark themes. */
export interface Screenshot {
  light: string;
  dark: string;
  alt: string;
}

export const SCREENSHOTS: Record<string, Screenshot[]> = {
  website_analytics: [
    { light: analyticsVisitsLight, dark: analyticsVisitsDark, alt: "Marketing's Website tab: visitors over the last 30 days against the 30 before, with page views, visits and booking requests" },
    { light: analyticsSourcesLight, dark: analyticsSourcesDark, alt: "The pages people read and where visits came from (Google, Facebook, Yelp), with the booking requests each brought in" },
  ],
  team_chat: [
    { light: crewLight, dark: crewDark, alt: "A crew's channel: a job linked in a message, an @mention, reactions, and who's online" },
    { light: announcementsLight, dark: announcementsDark, alt: "Announcements: a pinned message to @everyone that the whole team has seen" },
  ],
  sveltia: [
    { light: sveltiaPostLight, dark: sveltiaPostDark, alt: "Writing a blog post in Sveltia CMS, with a preview of the page beside it" },
    { light: sveltiaHoursLight, dark: sveltiaHoursDark, alt: "Changing the business's phone number, service area and hours" },
    { light: sveltiaServicesLight, dark: sveltiaServicesDark, alt: "The website's services, each with its starting price and season" },
  ],
};
