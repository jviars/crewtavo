import { describe, expect, it } from "vitest";
import { keyFileText, readKeyFile } from "../src/lib/keyFile";

describe("key file", () => {
  const keys = ["Y0JZ-FZK1-FP0B", "Y67P-PEDG-JM9G", "C8X3-3VR9-B8GF"];

  it("reads back the email and keys it was written with", () => {
    const text = keyFileText({ email: "pat@example.com", address: "https://crewtavo.up.railway.app", made: new Date(2026, 9, 17), keys });
    expect(readKeyFile(text)).toEqual({ email: "pat@example.com", keys });
  });

  it("reads files from the first version too", () => {
    const old = "Crewtavo spare keys for pat@example.com\nhttps://x\nMade 10/17/2026\n\nY0JZ-FZK1-FP0B\nY67P-PEDG-JM9G\n";
    expect(readKeyFile(old)).toEqual({ email: "pat@example.com", keys: keys.slice(0, 2) });
  });

  it("copes with a file someone opened and saved again", () => {
    const edited = "﻿Crewtavo key file\r\nAccount:  pat@example.com \r\n1. y0jz-fzk1-fp0b\r\n1. Y0JZ-FZK1-FP0B\r\n";
    expect(readKeyFile(edited)).toEqual({ email: "pat@example.com", keys: ["Y0JZ-FZK1-FP0B"] });
  });

  it("finds nothing in some other file", () => {
    expect(readKeyFile("Grocery list\nmilk\neggs\n")).toEqual({ email: null, keys: [] });
  });
});
