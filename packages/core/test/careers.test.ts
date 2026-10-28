import { describe, expect, it } from "vitest";
import { applicationEmail, exampleApplicationForm, fileKind, fileLabel, fileName, isResume, readApplication } from "../src/careers";
import { cleanFields } from "../src/websiteForms";

const application = (entries: Array<[string, unknown]>) => {
  const cleaned = cleanFields(entries);
  if (!cleaned.ok) throw new Error(cleaned.error);
  const result = readApplication(cleaned.fields);
  if (!result.ok) throw new Error(result.error);
  return result.application;
};

describe("reading an application", () => {
  it("reads who they are, what an employer asks, and keeps the rest as answers", () => {
    const a = application([
      ["Full Name", "Jane Smith"],
      ["E-mail Address", "Jane@Example.com"],
      ["Phone Number", "(540) 555-0101"],
      ["Position Applied For", "Crew member"],
      ["When can you start?", "Two weeks"],
      ["Full-time or part-time", "Full-time"],
      ["Desired Pay", "$18/hr"],
      ["Years of Experience", "3"],
      ["Valid Driver's License", "Yes"],
      ["City", "Radford"],
      ["State", "VA"],
      ["How did you hear about us?", "Indeed"],
      ["Current employer", "Lawn Co"],
      ["Company", "Acme Mowing"],
      ["Can you lift 50 lbs?", "Yes"],
      ["Tell us about yourself", "I love being outside."],
    ]);
    expect(a).toMatchObject({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "(540) 555-0101",
      details: {
        position: "Crew member", start_date: "Two weeks", availability: "Full-time", desired_pay: "$18/hr", experience: "3",
        drivers_license: "Yes", location: "Radford, VA", heard_from: "Indeed", message: "I love being outside.",
      },
      answers: { "Current employer": "Lawn Co", Company: "Acme Mowing", "Can you lift 50 lbs?": "Yes" },
    });
    expect(a.fields).toHaveLength(16);
  });

  it("takes a whole address as where they live, and a location field over it", () => {
    expect(application([["name", "A"], ["email", "a@x.test"], ["address", "12 Oak St"], ["city", "Radford"], ["zip", "24141"]]).details.location).toBe("12 Oak St, Radford, 24141");
    const a = application([["name", "A"], ["email", "a@x.test"], ["location", "Blacksburg"], ["address", "12 Oak St"]]);
    expect(a.details.location).toBe("Blacksburg");
  });

  it("uses a cover letter as the message, unless there's a message too", () => {
    expect(application([["email", "a@x.test"], ["cover_letter", "Hire me"]]).details.message).toBe("Hire me");
    const both = application([["email", "a@x.test"], ["message", "Hi"], ["cover_letter", "Hire me"]]);
    expect(both.details.message).toBe("Hi");
    expect(both.answers).toEqual({ cover_letter: "Hire me" });
  });

  it("keeps a second position field, and lists of positions together", () => {
    const a = application([["email", "a@x.test"], ["positions[]", ["Mowing", "Snow"]], ["job", "Driver"]]);
    expect(a.details.position).toBe("Mowing, Snow");
    expect(a.answers).toEqual({ job: "Driver" });
  });

  it("needs a way to reach them, and lets a bot think it worked", () => {
    const cleaned = cleanFields([["name", "Nobody"], ["position", "Crew"]]);
    expect(cleaned.ok && readApplication(cleaned.fields)).toEqual({ ok: false, error: "Add an email or phone number so we can reach you." });
    expect(application([["_gotcha", "x"], ["name", "Bot"]]).bot).toBe(true);
  });

  it("reads Formspree's fields the same as a contact form", () => {
    const a = application([["email", "a@x.test"], ["_subject", "Applicant!"], ["_next", "https://pine.test/thanks"]]);
    expect(a).toMatchObject({ subject: "Applicant!", next: "https://pine.test/thanks", answers: {} });
  });
});

describe("files", () => {
  it("are documents or pictures of them, by name first", () => {
    expect(fileKind("Jane Resume.DOCX", "application/octet-stream")).toEqual({ ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(fileKind("scan.jpeg", "image/jpeg")).toEqual({ ext: "jpg", type: "image/jpeg" });
    expect(fileKind("resume", "application/pdf")).toEqual({ ext: "pdf", type: "application/pdf" });
    expect(fileKind("virus.exe", "application/pdf")).toEqual({ ext: "pdf", type: "application/pdf" });
    expect(fileKind("virus.exe", "application/x-msdownload")).toBeNull();
    expect(fileKind("page.html", "text/html")).toBeNull();
  });

  it("keep a tidy name with their own extension", () => {
    expect(fileName("C:\\Users\\jane\\My Résumé (2026).docx", "docx")).toBe("My Résumé (2026).docx");
    expect(fileName("../../etc/passwd<script>.pdf", "pdf")).toBe("passwd script.pdf");
    expect(fileName("", "pdf")).toBe("file.pdf");
  });

  it("are called by the field they came in, and the résumé is found", () => {
    expect(fileLabel("resume")).toBe("Résumé");
    expect(fileLabel("CV")).toBe("Résumé");
    expect(fileLabel("cover_letter")).toBe("Cover letter");
    expect(fileLabel("forklift_cert")).toBe("Forklift cert");
    const files = [{ field: "cover_letter" }, { field: "resume" }];
    expect(isResume(files[1]!, files)).toBe(true);
    expect(isResume(files[0]!, files)).toBe(false);
    const unnamed = [{ field: "attachment" }, { field: "other" }];
    expect(isResume(unnamed[0]!, unnamed)).toBe(true);
    expect(isResume({ field: "cover_letter" }, [{ field: "cover_letter" }])).toBe(false);
  });
});

describe("the email for each application", () => {
  it("says who applied for what, lists everything they typed and the files, and replies to them", () => {
    const a = application([["name", "Jane Smith"], ["email", "jane@x.test"], ["position", "Crew lead"], ["message", "Line one\nLine two"]]);
    const email = applicationEmail({ formName: "Job application", application: a, files: [{ name: "resume.pdf", field: "resume", size: 250_000 }], link: "https://crm.pine.test/applicants/1" });
    expect(email.subject).toBe("New application from Jane Smith for Crew lead");
    expect(email.text).toContain("Position: Crew lead");
    expect(email.text).toContain("Message:\nLine one\nLine two");
    expect(email.text).toContain("Résumé: resume.pdf (244 KB)\nOpen it in Crewtavo.");
    expect(email.text).toContain("Reply to this email to answer Jane.");
  });
});

describe("the example form", () => {
  it("sends files, to the form's address, with the honeypot", () => {
    const html = exampleApplicationForm("https://crm.pine.test/f/abc12345");
    expect(html).toContain(`action="https://crm.pine.test/f/abc12345" method="POST" enctype="multipart/form-data"`);
    expect(html).toContain(`type="file" name="resume"`);
    expect(html).toContain(`name="_gotcha"`);
  });

  it("asks only for fields the reader knows, so none of them end up as other answers", () => {
    const names = [...exampleApplicationForm("https://crm.pine.test/f/abc12345").matchAll(/name="([^"]+)"/g)].map((m) => m[1]!).filter((n) => !n.startsWith("_") && n !== "resume");
    const a = application(names.map((n) => [n, n === "email" ? "a@x.test" : n === "phone" ? "540 555 0101" : "x"]));
    expect(a.answers).toEqual({});
    expect(Object.keys(a.details).sort()).toEqual(["availability", "drivers_license", "experience", "heard_from", "location", "message", "position", "start_date"]);
  });
});
