/**
 * The GitHub workflows that check and publish the images every instance installs on its own
 * (.github/workflows): each action they use is pinned to a commit, so a tag moved on another
 * repository can't change what runs with this repository's token.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));

describe("the GitHub workflows", () => {
  it("pin every action to a commit, with its version beside it", () => {
    const uses = workflows.flatMap((name) =>
      [...readFileSync(dir + name, "utf8").matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)].map((m) => ({ name, action: m[1]!, note: m[2]!.trim() })),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const { name, action, note } of uses) {
      // A workflow in this repository runs from the same commit as the one that calls it.
      if (action.startsWith("./")) continue;
      expect(action, name).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(note, `${name}: ${action}`).toMatch(/^# v\d+\.\d+\.\d+$/);
    }
  });
});
