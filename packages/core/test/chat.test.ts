import { describe, expect, it } from "vitest";
import { channelSlug, chatRoleKey, fromEditable, matchMentions, messageParts, plainMessage, roleToken, toEditable, userToken, EVERYONE_TOKEN } from "../src/chat";

const MARCUS = "c4a70000-0000-0000-0000-000000000004";
const SAM = "c4a70000-0000-0000-0000-000000000007";
const SAMANTHA = "c4a70000-0000-0000-0000-000000000008";
const SEASONAL = "0b8b8a3c-1f53-4d9e-9a49-3c2a1b0f7e11";

describe("chat mentions", () => {
  it("reads people, roles and @everyone out of a message, in order", () => {
    expect(messageParts(`Hi <@${MARCUS}>, ask <@&office> or <@&${SEASONAL}>. @everyone`)).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "user", id: MARCUS },
      { kind: "text", text: ", ask " },
      { kind: "role", key: "office" },
      { kind: "text", text: " or " },
      { kind: "role", key: SEASONAL },
      { kind: "text", text: ". " },
      { kind: "everyone" },
    ]);
  });

  it("leaves look-alikes as text: an email, a bad id, @everyones", () => {
    expect(messageParts("mail sam@everyone.test, <@not-an-id>, @everyones")).toEqual([{ kind: "text", text: "mail sam@everyone.test, <@not-an-id>, @everyones" }]);
  });

  it("turns picked names into tokens, longest name first and only as whole words", () => {
    const picked = [
      { label: "Sam", token: userToken(SAM) },
      { label: "Sam Ortiz", token: userToken(SAMANTHA) },
      { label: "Field crew", token: roleToken("field_crew") },
    ];
    expect(fromEditable("@Sam Ortiz and @Sam, @field crew: email sam@Sam.test, @Samuel", picked)).toBe(
      `${userToken(SAMANTHA)} and ${userToken(SAM)}, ${roleToken("field_crew")}: email sam@Sam.test, @Samuel`,
    );
  });

  it("puts names back for editing, and back to tokens again", () => {
    const body = `${userToken(MARCUS)} loaded truck 3 ${roleToken("office")} ${EVERYONE_TOKEN}`;
    const names = (p: { kind: string; id?: string; key?: string }) => (p.kind === "user" ? "Marcus Reyes" : p.kind === "role" ? "Office" : "everyone");
    const editable = toEditable(body, names);
    expect(editable).toBe("@Marcus Reyes loaded truck 3 @Office @everyone");
    expect(fromEditable(editable, [{ label: "Marcus Reyes", token: userToken(MARCUS) }, { label: "Office", token: roleToken("office") }])).toBe(body);
    expect(plainMessage(`  ${body}\n\nthanks `, names)).toBe("@Marcus Reyes loaded truck 3 @Office @everyone thanks");
  });

  it("suggests names that start with what was typed, then ones that contain it", () => {
    const options = [{ label: "Tyler Brooks", token: "a" }, { label: "Marcus Reyes", token: "b" }, { label: "Field crew", token: "c" }, { label: "Office", token: "d" }];
    expect(matchMentions(options, "re").map((o) => o.label)).toEqual(["Marcus Reyes", "Field crew"]);
    expect(matchMentions(options, "cr").map((o) => o.label)).toEqual(["Field crew"]);
    expect(matchMentions(options, "o").map((o) => o.label)).toEqual(["Office", "Tyler Brooks"]);
    expect(matchMentions(options, "").length).toBe(4);
  });
});

describe("chat channels and roles", () => {
  it("makes a channel name the way the database does", () => {
    expect(channelSlug("North Crew!")).toBe("north-crew");
    expect(channelSlug("  Equipment & Trucks  ")).toBe("equipment-trucks");
    expect(channelSlug("!!!")).toBe("channel");
    expect(channelSlug("a".repeat(60))).toHaveLength(44);
  });

  it("goes by a custom role's id, else the access level", () => {
    expect(chatRoleKey("field_crew", null)).toBe("field_crew");
    expect(chatRoleKey("field_crew", SEASONAL)).toBe(SEASONAL);
  });
});
