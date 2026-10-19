/**
 * The owner's key file: their spare keys in a plain text file they download when they set up
 * Crewtavo, and upload on the sign-in page if they forget their password while Crewtavo can't email
 * them. Plain text, so it opens and prints anywhere. The API uses the first key in it that hasn't been
 * used, so one file works as many times as it has keys (apps/api/src/routes/recovery.ts).
 */

/** A spare key as shown: three groups of four from Crockford's base32 (apps/api/src/lib/recovery.ts). */
const KEY = /\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g;

export const KEY_FILE_NAME = "crewtavo-key-file.txt";

export function keyFileText({ email, address, made, keys }: { email: string; address: string; made: Date; keys: string[] }): string {
  return [
    "Crewtavo key file",
    "",
    `Account: ${email}`,
    `Crewtavo: ${address}`,
    `Made: ${made.toLocaleDateString()}`,
    "",
    "Forgot your password? On the Crewtavo sign-in page, choose Forgot password, then",
    '"I\'m the owner: use my key file", and upload this file. Each key in it works once.',
    "",
    "Keep this file safe. Anyone who has it can get into your account.",
    "",
    "Spare keys:",
    ...keys.map((key, i) => `${i + 1}. ${key}`),
    "",
  ].join("\n");
}

/** What a key file holds: the account's email and its keys. Also reads the older "spare keys for" wording. */
export function readKeyFile(text: string): { email: string | null; keys: string[] } {
  const email = text.match(/^\s*(?:Account:|Crewtavo spare keys for)\s*(\S+@\S+)\s*$/im)?.[1] ?? null;
  const keys = [...new Set(text.toUpperCase().match(KEY) ?? [])];
  return { email, keys };
}
