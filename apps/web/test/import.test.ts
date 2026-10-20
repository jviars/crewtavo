import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/lib/csv";
import { guessMapping, toClients } from "../src/features/clients/importClients";

const read = (csv: string) => {
  const rows = parseCsv(csv);
  return toClients(rows.slice(1), guessMapping(rows[0]!));
};

describe("client import", () => {
  it("reads a Jobber-style clients export", () => {
    const rows = parseCsv(
      [
        "J-ID,Display Name,First Name,Last Name,Company Name,Main Phone #s,E-mails,Billing Street 1,Billing City,Billing State,Billing Zip code,Service Property Name,Service Street 1,Service City,Service State,Service Zip code,Tags,Lead Source",
        '101,Summit Ridge Builders,,,Summit Ridge Builders LLC,"(540) 555-0141, (540) 555-0142","pm@summitridge.test, ap@summitridge.test",9 Main St,Rocky Mount,VA,24151,Phase 2,2200 Summit Ridge Rd,Rocky Mount,VA,24151,GC;Commercial,Referral',
        "101,Summit Ridge Builders,,,,,,,,,,Phase 3,2400 Summit Ridge Rd,Rocky Mount,VA,24151,,",
        "102,,Jordan,Rivera,,(540) 555-0187,jordan@example.com,418 Pell Ave,Roanoke,VA,24012,,,,,,,",
      ].join("\n"),
    );
    const mapping = guessMapping(rows[0]!);
    expect(Object.keys(mapping)).toEqual(expect.arrayContaining(["client_ref", "display_name", "email", "phone", "line1", "city", "billing_line1", "label", "tags", "lead_source"]));
    const clients = toClients(rows.slice(1), mapping);
    expect(clients).toHaveLength(2);
    const summit = clients[0]!;
    expect(summit).toMatchObject({ display_name: "Summit Ridge Builders", email: "pm@summitridge.test", phone: "(540) 555-0141", tags: ["GC", "Commercial"], lead_source: "Referral" });
    expect(summit.properties.map((p) => p.line1)).toEqual(["2200 Summit Ridge Rd", "2400 Summit Ridge Rd"]);
    expect(summit.properties[1]!.label).toBe("Phase 3");
    expect(summit.billing).toMatchObject({ line1: "9 Main St", city: "Rocky Mount" });
    // Only a billing address: that's where the work is.
    expect(clients[1]).toMatchObject({ display_name: "Jordan Rivera", properties: [{ line1: "418 Pell Ave", city: "Roanoke" }] });
  });

  it("groups a properties export by client and skips repeats and nameless rows", () => {
    const clients = read(["Client Name,Client Email,Street 1,City", "Meadowbrook HOA,board@hoa.test,75 Meadowbrook Ln,Rocky Mount", "Meadowbrook HOA,board@hoa.test,75 Meadowbrook Lane,Rocky Mount", "Meadowbrook HOA,board@hoa.test,80 Pool Rd,Rocky Mount", ",x@y.test,1 Nowhere,Rocky Mount"].join("\n"));
    expect(clients).toHaveLength(1);
    // "Lane" and "Ln" are the same street.
    expect(clients[0]!.properties.map((p) => p.line1)).toEqual(["75 Meadowbrook Ln", "80 Pool Rd"]);
  });

  it("keeps a stray quote inside a field instead of swallowing the rows after it", () => {
    expect(parseCsv('Name,Note\nAcme,12" curb\nBeta,two\nGamma,three')).toEqual([["Name", "Note"], ["Acme", '12" curb'], ["Beta", "two"], ["Gamma", "three"]]);
    expect(parseCsv('Name,Height\nDana,5\'10"\r\nLee,6\'\r\n')).toEqual([["Name", "Height"], ["Dana", "5'10\""], ["Lee", "6'"]]);
    // Quoted fields still hold commas, line breaks and doubled quotes.
    expect(parseCsv('Name,Note\n"Acme, Inc.","Line one\nsaid ""hi"""\n"",x')).toEqual([["Name", "Note"], ["Acme, Inc.", 'Line one\nsaid "hi"'], ["", "x"]]);
  });

  it("reads a quoted field after the comma's space without shifting the columns after it", () => {
    expect(parseCsv('Name, Note, City\nAcme, "12 Main St, Unit 4", Roanoke\nBeta,  "said ""hi""",x')).toEqual([
      ["Name", " Note", " City"],
      ["Acme", "12 Main St, Unit 4", " Roanoke"],
      ["Beta", 'said "hi"', "x"],
    ]);
    // A quote after anything but spaces is still just a character.
    expect(parseCsv('Name,Note\nAcme, 12" curb, x\nBeta,two')).toEqual([["Name", "Note"], ["Acme", ' 12" curb', " x"], ["Beta", "two"]]);
  });

  it("matches plain spreadsheets too", () => {
    const clients = read(["Name,Email,Phone,Address,City,State,Zip", "Priya Shah,PRIYA@EXAMPLE.COM,540-555-0163,9 Hillcrest Ct,Roanoke,VA,24018"].join("\n"));
    expect(clients[0]).toMatchObject({ display_name: "Priya Shah", email: "priya@example.com", properties: [{ line1: "9 Hillcrest Ct", region: "VA", postal_code: "24018" }] });
  });
});
