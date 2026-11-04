import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repeatText, scheduleText, seasonText } from "../src/features/jobs/repeatText";

// The job page says a recurring job's repeat in sentence case, the way the rest of the app writes.
describe("a job's repeat", () => {
  it("reads weekly rules by their days, in week order", () => {
    expect(repeatText("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO")).toBe("Weekly, Monday");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH,MO")).toBe("Weekly, Monday and Thursday");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU")).toBe("Every 2 weeks, Tuesday");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR")).toBe("Every weekday");
    expect(repeatText("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBe("Weekly, Monday, Wednesday and Friday");
  });

  it("reads monthly rules by the day of the month or the weekday in it", () => {
    expect(repeatText("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1")).toBe("Monthly, the 1st");
    expect(repeatText("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=22")).toBe("Every 3 months, the 22nd");
    expect(repeatText("FREQ=MONTHLY;BYMONTHDAY=11")).toBe("Monthly, the 11th");
    expect(repeatText("FREQ=MONTHLY;BYDAY=1MO")).toBe("Monthly, first Monday");
    expect(repeatText("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1")).toBe("Monthly, last Friday");
    expect(repeatText("RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=3WE")).toBe("Every 2 months, third Wednesday");
  });

  it("falls back to RRule's wording, capitalized, for anything else", () => {
    expect(repeatText("FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15")).toBe("Every April on the 15th");
    expect(repeatText("FREQ=DAILY;INTERVAL=1")).toBe("Daily");
  });
});

// A quote for recurring work tells the client how often, season and all.
describe("how often, on a quote", () => {
  it("reads a season as a run of months, or names them", () => {
    expect(seasonText([4, 5, 6, 7, 8, 9, 10])).toBe("April to October");
    expect(seasonText([10, 4, 5, 6, 7, 8, 9])).toBe("April to October");
    expect(seasonText([6, 7])).toBe("June and July");
    expect(seasonText([6, 7, 12])).toBe("June, July and December");
    expect(seasonText(null)).toBeNull();
    expect(seasonText([])).toBeNull();
    expect(seasonText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBeNull();
  });

  it("says the repeat, then the season", () => {
    expect(scheduleText("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", [4, 5, 6, 7, 8, 9, 10])).toBe("Every 2 weeks, Tuesday, April to October");
    expect(scheduleText("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", null)).toBe("Weekly, Monday");
  });
});

// A job shows Late, Today, Upcoming or Unscheduled from its visits (public.job_state), so whatever
// changes a visit's status, date or job refreshes the Jobs list (["jobs", …]) and job pages (["job", …]).
describe("the Jobs list after a visit changes", () => {
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("refreshes from the field app, the visit dialog and the schedule", () => {
    expect(source("../src/features/field/FieldVisitPage.tsx")).toMatch(/\["schedule"\], \["job"\], \["jobs"\]/);
    const today = source("../src/features/field/FieldTodayPage.tsx");
    expect(today).toContain(`queryClient.invalidateQueries({ queryKey: ["job"] });\n    queryClient.invalidateQueries({ queryKey: ["jobs"] });`);
    expect(source("../src/features/schedule/VisitDialog.tsx")).toContain(`["schedule", "job", "jobs", "request", "dashboard", "field"]`);
    // Dragging a visit, moving a day's visits, and adding a visit to many jobs.
    const schedule = source("../src/features/schedule/SchedulePage.tsx");
    expect(schedule).toContain(`for (const key of ["jobs", "job"]) queryClient.invalidateQueries({ queryKey: [key] });`);
    expect(schedule.match(/refreshJobs\(queryClient\);/g)).toHaveLength(3);
  });
});

// A new job takes the business's job fields too, as its details dialog does.
describe("the new job dialog", () => {
  it("fills in the job's custom fields and saves them with it", () => {
    const dialog = readFileSync(fileURLToPath(new URL("../src/features/jobs/JobDialogs.tsx", import.meta.url)), "utf8");
    const create = dialog.slice(dialog.indexOf("export function NewJobDialog"), dialog.indexOf("export interface JobRecord"));
    expect(create).toContain(`const customFields = useCustomFields("job");`);
    expect(create).toContain(`custom_fields: customFieldsToSave(customFields, null, custom)`);
    expect(create).toContain(`<CustomFieldInputs fields={customFields} current={null} draft={custom} onChange={setCustom} />`);
  });
});
