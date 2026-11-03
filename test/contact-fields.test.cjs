"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContactFieldHelpers(stripEmailContentMarkers = (value) => value) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const startMarker = "// BEGIN CONTACT FIELD HELPERS";
  const endMarker = "// END CONTACT FIELD HELPERS";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0, "contact field helper start marker missing");
  assert.ok(end > start, "contact field helper end marker missing");

  const snippet = source.slice(start, end);
  // applyContactFields strips <email-content> markers from fields.note
  // before writing it (stripEmailContentMarkers, declared in the untrusted
  // content helpers elsewhere in api.js, not part of this marked block):
  // an identity stub here since this suite is about field mapping, not
  // marker stripping (covered by untrusted-content.test.cjs).
  const sandbox = { stripEmailContentMarkers };
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
this.contactFieldHelpers = {
  normalizeContactBirthday,
  contactBirthdayToVCard,
  contactBirthdayToFlatParts,
  validateContactFields,
  readContactFields,
  formatContact,
  applyContactFields,
  shouldSynthesizePhoneDisplayName,
  isValidContactEmailAddress,
  validateContactEmails,
  orderContactEmails,
};`,
    sandbox
  );
  return sandbox.contactFieldHelpers;
}

const helpers = loadContactFieldHelpers();

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeVCardPropertyEntry {
  constructor(name, params, type, value) {
    this.name = name;
    this.params = params;
    this.type = type;
    this.value = value;
  }
}

class FakeVCardProperties {
  constructor(entries = []) {
    this.entries = entries;
  }

  getAllEntries(name) {
    return this.entries.filter(entry => entry.name === name);
  }

  // Same ordering rule as Thunderbird's VCardProperties.getAllEntriesSorted:
  // PREF first (numeric), then the position of the entry.
  getAllEntriesSorted(name) {
    let nextPref = 101;
    return this.getAllEntries(name)
      .map(entry => ({ entry, pref: entry.params.pref || nextPref++ }))
      .sort((a, b) => a.pref - b.pref)
      .map(item => item.entry);
  }

  getFirstEntry(name) {
    return this.getAllEntries(name)[0] || null;
  }

  getFirstValue(name) {
    return this.getFirstEntry(name)?.value ?? null;
  }

  addEntry(entry) {
    this.entries.push(entry);
  }

  removeEntry(entry) {
    const index = this.entries.indexOf(entry);
    if (index >= 0) this.entries.splice(index, 1);
  }

  clearValues(name) {
    this.entries = this.entries.filter(entry => entry.name !== name);
  }
}

function makeFlatCard(properties = {}) {
  const stored = new Map(Object.entries(properties));
  return {
    UID: "flat-uid",
    supportsVCard: false,
    displayName: "Flat Contact",
    primaryEmail: "flat@example.com",
    firstName: "Flat",
    lastName: "Contact",
    getProperty(name, fallback = "") {
      return stored.has(name) ? stored.get(name) : fallback;
    },
    setProperty(name, value) {
      stored.set(name, value);
    },
    stored,
  };
}

describe("contact birthday normalization", () => {
  it("accepts API and serialized full-date forms", () => {
    assert.equal(helpers.normalizeContactBirthday("1980-04-15"), "1980-04-15");
    assert.equal(helpers.normalizeContactBirthday("19800415"), "1980-04-15");
    assert.equal(helpers.contactBirthdayToVCard("1980-04-15"), "1980-04-15");
  });

  it("accepts yearless birthdays and emits canonical forms", () => {
    assert.equal(helpers.normalizeContactBirthday("--04-15"), "--04-15");
    assert.equal(helpers.normalizeContactBirthday("--0415"), "--04-15");
    assert.equal(helpers.contactBirthdayToVCard("--04-15"), "--04-15");
    assert.deepEqual(plain(helpers.contactBirthdayToFlatParts("--04-15")), {
      year: "",
      month: "04",
      day: "15",
    });
  });

  it("rejects impossible and malformed dates", () => {
    assert.equal(helpers.normalizeContactBirthday("2023-02-29"), null);
    assert.equal(helpers.normalizeContactBirthday("--13-01"), null);
    assert.equal(helpers.normalizeContactBirthday("04-15"), null);
    assert.equal(helpers.normalizeContactBirthday(" "), null);
    assert.equal(helpers.normalizeContactBirthday("--02-29"), "--02-29");
    assert.equal(helpers.normalizeContactBirthday("2000-02-29"), "2000-02-29");
  });
});

describe("contact handler payload validation", () => {
  it("accepts a phone-only create payload", () => {
    assert.equal(helpers.validateContactFields({
      phones: [{ type: "mobile", number: "+48 123 456 789" }],
    }, true), null);
  });

  it("rejects a wholly empty create payload", () => {
    assert.match(
      helpers.validateContactFields({ email: "", phones: [], addresses: [] }, true),
      /non-empty contact field/
    );
  });

  it("deep-validates phone objects", () => {
    assert.match(
      helpers.validateContactFields({ phones: [{ type: "cell", number: "123" }] }),
      /phones\[0\]\.type/
    );
    assert.match(
      helpers.validateContactFields({ phones: [{ type: "home", number: " " }] }),
      /non-empty string/
    );
    assert.match(
      helpers.validateContactFields({ phones: [{ type: "home", number: "123", label: "x" }] }),
      /Unknown phones\[0\] property/
    );
  });

  it("deep-validates postal address objects", () => {
    assert.equal(helpers.validateContactFields({
      addresses: [{ type: "work", street: "1 Main St", city: "Warsaw" }],
    }), null);
    assert.match(
      helpers.validateContactFields({ addresses: [{ type: "other", city: "Warsaw" }] }),
      /addresses\[0\]\.type/
    );
    assert.match(
      helpers.validateContactFields({ addresses: [{ type: "home" }] }),
      /at least one non-empty address field/
    );
    assert.match(
      helpers.validateContactFields({ addresses: [{ type: "home", city: 42 }] }),
      /addresses\[0\]\.city must be a string/
    );
  });

  it("validates scalar types and birthday calendar values", () => {
    assert.match(helpers.validateContactFields({ email: null }), /email must be a string/);
    assert.match(helpers.validateContactFields({ birthday: "2023-02-29" }), /birthday/);
    assert.equal(helpers.validateContactFields({ birthday: "--02-29" }), null);
    assert.equal(helpers.validateContactFields({ birthday: "" }), null);
  });
});

describe("contact field reads", () => {
  it("formats vCard-backed cards with the full contact shape", () => {
    const vCardProperties = new FakeVCardProperties([
      new FakeVCardPropertyEntry("email", { type: ["INTERNET", "HOME"] }, "text", "ada.home@example.org"),
      new FakeVCardPropertyEntry("email", { pref: "1" }, "text", "ada@example.com"),
      new FakeVCardPropertyEntry("tel", { type: "WORK" }, "text", "+48 111"),
      new FakeVCardPropertyEntry("tel", { type: ["voice", "cell"] }, "uri", "tel:+48 222"),
      new FakeVCardPropertyEntry(
        "adr",
        { type: "home" },
        "text",
        ["PO 1", "Apt 2", ["Main St", "Floor 3"], "Warsaw", "Mazovia", "00-001", "Poland"]
      ),
      new FakeVCardPropertyEntry("org", {}, "text", ["Example Corp", "Research"]),
      new FakeVCardPropertyEntry("title", {}, "text", "Engineer"),
      new FakeVCardPropertyEntry("note", {}, "text", ["line one", "line two"]),
      new FakeVCardPropertyEntry("bday", {}, "date", "--0415"),
    ]);
    const card = {
      UID: "vcard-uid",
      supportsVCard: true,
      vCardProperties,
      displayName: "Ada Example",
      primaryEmail: "ada@example.com",
      firstName: "Ada",
      lastName: "Example",
    };

    assert.deepEqual(plain(helpers.formatContact(card, {
      dirName: "Personal",
      URI: "jsaddrbook://abook.sqlite",
    })), {
      id: "vcard-uid",
      displayName: "Ada Example",
      email: "ada@example.com",
      emails: [
        { address: "ada@example.com", primary: true },
        { address: "ada.home@example.org", type: "home" },
      ],
      firstName: "Ada",
      lastName: "Example",
      phones: [
        { type: "work", number: "+48 111" },
        { type: "mobile", number: "+48 222" },
      ],
      addresses: [{
        type: "home",
        poBox: "PO 1",
        street2: "Apt 2",
        street: "Main St Floor 3",
        city: "Warsaw",
        region: "Mazovia",
        postalCode: "00-001",
        country: "Poland",
      }],
      organization: "Example Corp",
      title: "Engineer",
      note: "line one,line two",
      birthday: "--04-15",
      addressBook: "Personal",
      addressBookId: "jsaddrbook://abook.sqlite",
    });
  });

  it("reads the same fields from legacy flat cards", () => {
    const card = makeFlatCard({
      SecondEmail: "flat.second@example.com",
      HomePhone: "555-0100",
      CellularNumber: "555-0101",
      WorkAddress: "1 Main St",
      WorkCity: "Warsaw",
      WorkCountry: "Poland",
      Company: "Legacy Ltd",
      JobTitle: "Director",
      Notes: "legacy note",
      BirthYear: "1980",
      BirthMonth: "4",
      BirthDay: "5",
    });
    const details = plain(helpers.readContactFields(card));
    assert.deepEqual(details.emails, [
      { address: "flat@example.com", primary: true },
      { address: "flat.second@example.com" },
    ]);
    assert.deepEqual(details.phones, [
      { type: "home", number: "555-0100" },
      { type: "mobile", number: "555-0101" },
    ]);
    assert.deepEqual(details.addresses, [{
      type: "work",
      street: "1 Main St",
      city: "Warsaw",
      country: "Poland",
    }]);
    assert.equal(details.organization, "Legacy Ltd");
    assert.equal(details.title, "Director");
    assert.equal(details.note, "legacy note");
    assert.equal(details.birthday, "1980-04-05");
  });
});

describe("contact field writes", () => {
  it("selectively updates vCard entries and preserves unrelated properties", () => {
    const org = new FakeVCardPropertyEntry("org", {}, "text", ["Old Corp", "Research", "Team A"]);
    const secondOrg = new FakeVCardPropertyEntry("org", { type: "other" }, "text", ["Affiliation"]);
    const url = new FakeVCardPropertyEntry("url", { type: "work" }, "uri", "https://example.com");
    const im = new FakeVCardPropertyEntry("impp", {}, "uri", "xmpp:ada@example.com");
    const custom = new FakeVCardPropertyEntry("x-custom", {}, "text", "keep-me");
    const vCardProperties = new FakeVCardProperties([
      new FakeVCardPropertyEntry("tel", { type: "home" }, "text", "old-phone"),
      new FakeVCardPropertyEntry("adr", { type: "home" }, "text", ["", "", "Old St", "", "", "", ""]),
      org,
      secondOrg,
      new FakeVCardPropertyEntry("title", {}, "text", "Old title"),
      new FakeVCardPropertyEntry("note", {}, "text", "Old note"),
      new FakeVCardPropertyEntry("bday", {}, "date", "19700101"),
      url,
      im,
      custom,
    ]);
    const card = {
      supportsVCard: true,
      vCardProperties,
      primaryEmail: "old@example.com",
      displayName: "Old Name",
      firstName: "Old",
      lastName: "Name",
    };

    helpers.applyContactFields(card, {
      email: "new@example.com",
      phones: [
        { type: "work", number: " 555-1000 " },
        { type: "mobile", number: "555-1001" },
      ],
      addresses: [{ type: "work", street: "New St", city: "Warsaw" }],
      organization: "New Corp",
      title: "",
      note: "first line\nsecond line",
      birthday: "--04-15",
    }, FakeVCardPropertyEntry);

    assert.equal(card.primaryEmail, "new@example.com");
    assert.deepEqual(vCardProperties.getAllEntries("tel").map(entry => ({
      type: entry.params.type,
      value: entry.value,
    })), [
      { type: "work", value: "555-1000" },
      { type: "cell", value: "555-1001" },
    ]);
    assert.deepEqual(plain(vCardProperties.getFirstValue("adr")), ["", "", "New St", "Warsaw", "", "", ""]);
    assert.strictEqual(vCardProperties.getFirstEntry("org"), org);
    assert.deepEqual(plain(org.value), ["New Corp", "Research", "Team A"]);
    assert.strictEqual(vCardProperties.getAllEntries("org")[1], secondOrg);
    assert.equal(vCardProperties.getAllEntries("title").length, 0);
    assert.equal(vCardProperties.getFirstValue("note"), "first line\nsecond line");
    assert.equal(vCardProperties.getFirstValue("bday"), "--04-15");
    assert.ok(vCardProperties.entries.includes(url));
    assert.ok(vCardProperties.entries.includes(im));
    assert.ok(vCardProperties.entries.includes(custom));
  });

  it("reuses vCard phone and address entries while preserving their metadata", () => {
    const changedPhoneParams = { type: ["VOICE", "WORK"], pref: "1" };
    const changedPhone = new FakeVCardPropertyEntry(
      "tel",
      changedPhoneParams,
      "uri",
      "tel:+48 100"
    );
    changedPhone.group = "item1";
    const exactPhoneParams = { type: ["WORK", "VOICE"], pref: "2" };
    const exactPhone = new FakeVCardPropertyEntry(
      "tel",
      exactPhoneParams,
      "text",
      "+48 200"
    );
    exactPhone.group = "item2";
    const omittedPhone = new FakeVCardPropertyEntry(
      "tel",
      { type: "home", pref: "3" },
      "text",
      "+48 300"
    );

    const changedAddressParams = { type: ["WORK", "parcel"], pref: "1" };
    const changedAddress = new FakeVCardPropertyEntry(
      "adr",
      changedAddressParams,
      "text",
      ["", "", "Old Street", "Old City", "", "", ""]
    );
    changedAddress.group = "item3";
    const exactAddressParams = { type: ["WORK", "postal"], pref: "2" };
    const exactAddressValue = ["", "", ["Exact Street", "Suite 5"], "Warsaw", "", "", "Poland"];
    const exactAddress = new FakeVCardPropertyEntry(
      "adr",
      exactAddressParams,
      "text",
      exactAddressValue
    );
    exactAddress.group = "item4";
    const omittedAddress = new FakeVCardPropertyEntry(
      "adr",
      { type: "home" },
      "text",
      ["", "", "Home Street", "", "", "", ""]
    );

    const vCardProperties = new FakeVCardProperties([
      changedPhone,
      exactPhone,
      omittedPhone,
      changedAddress,
      exactAddress,
      omittedAddress,
    ]);
    const result = helpers.applyContactFields({ supportsVCard: true, vCardProperties }, {
      phones: [
        { type: "work", number: "+48 200" },
        { type: "work", number: "+48 400" },
      ],
      addresses: [
        { type: "work", street: "Exact Street Suite 5", city: "Warsaw", country: "Poland" },
        { type: "work", street: "New Street", city: "Krakow" },
      ],
    }, FakeVCardPropertyEntry);

    assert.equal(result, null);
    assert.deepEqual(vCardProperties.getAllEntries("tel"), [changedPhone, exactPhone]);
    assert.equal(changedPhone.value, "tel:+48 400");
    assert.equal(changedPhone.type, "uri");
    assert.strictEqual(changedPhone.params, changedPhoneParams);
    assert.equal(changedPhone.group, "item1");
    assert.equal(exactPhone.value, "+48 200");
    assert.strictEqual(exactPhone.params, exactPhoneParams);
    assert.equal(exactPhone.group, "item2");
    assert.ok(!vCardProperties.entries.includes(omittedPhone));

    assert.deepEqual(vCardProperties.getAllEntries("adr"), [changedAddress, exactAddress]);
    assert.deepEqual(plain(changedAddress.value), ["", "", "New Street", "Krakow", "", "", ""]);
    assert.strictEqual(changedAddress.params, changedAddressParams);
    assert.equal(changedAddress.group, "item3");
    assert.strictEqual(exactAddress.value, exactAddressValue);
    assert.strictEqual(exactAddress.params, exactAddressParams);
    assert.equal(exactAddress.group, "item4");
    assert.ok(!vCardProperties.entries.includes(omittedAddress));
  });

  it("keeps duplicate types on newly populated vCard cards", () => {
    const vCardProperties = new FakeVCardProperties();
    const result = helpers.applyContactFields({ supportsVCard: true, vCardProperties }, {
      phones: [
        { type: "work", number: "555-0100" },
        { type: "work", number: "555-0101" },
      ],
      addresses: [
        { type: "home", street: "First Home" },
        { type: "home", street: "Second Home" },
      ],
    }, FakeVCardPropertyEntry);

    assert.equal(result, null);
    assert.deepEqual(vCardProperties.getAllEntries("tel").map(entry => entry.value), [
      "555-0100",
      "555-0101",
    ]);
    assert.deepEqual(vCardProperties.getAllEntries("adr").map(entry => entry.value[2]), [
      "First Home",
      "Second Home",
    ]);
  });

  it("strips email-content markers from a vCard note like the flat Notes property", () => {
    const stripping = loadContactFieldHelpers(value => value.replaceAll("<marker>", ""));
    const vCardProperties = new FakeVCardProperties();
    stripping.applyContactFields({ supportsVCard: true, vCardProperties }, {
      note: "<marker>copied<marker>",
    }, FakeVCardPropertyEntry);
    assert.equal(vCardProperties.getFirstValue("note"), "copied");
    const flat = makeFlatCard();
    stripping.applyContactFields(flat, { note: "<marker>copied" }, FakeVCardPropertyEntry);
    assert.equal(flat.stored.get("Notes"), "copied");
  });

  it("keeps later ORG components when organization is cleared", () => {
    const org = new FakeVCardPropertyEntry("org", {}, "text", ["Old Corp", "Department"]);
    const card = {
      supportsVCard: true,
      vCardProperties: new FakeVCardProperties([org]),
    };
    helpers.applyContactFields(card, { organization: "" }, FakeVCardPropertyEntry);
    assert.deepEqual(plain(org.value), ["", "Department"]);
  });

  it("clears the exposed organization while preserving additional ORG entries", () => {
    const primaryOrg = new FakeVCardPropertyEntry("org", {}, "text", "Old Corp");
    const affiliation = new FakeVCardPropertyEntry("org", {}, "text", ["Affiliation"]);
    const card = {
      supportsVCard: true,
      vCardProperties: new FakeVCardProperties([primaryOrg, affiliation]),
    };
    helpers.applyContactFields(card, { organization: "" }, FakeVCardPropertyEntry);
    assert.deepEqual(plain(primaryOrg.value), [""]);
    assert.strictEqual(card.vCardProperties.getAllEntries("org")[1], affiliation);
  });

  it("uses empty values to clear vCard email, phone, and address fields", () => {
    const vCardProperties = new FakeVCardProperties([
      new FakeVCardPropertyEntry("email", { pref: "1" }, "text", "primary@example.com"),
      new FakeVCardPropertyEntry("email", {}, "text", "secondary@example.com"),
      new FakeVCardPropertyEntry("tel", { type: "home" }, "text", "555"),
      new FakeVCardPropertyEntry("adr", { type: "home" }, "text", ["", "", "Street"]),
      new FakeVCardPropertyEntry("url", {}, "uri", "https://example.com"),
    ]);
    helpers.applyContactFields({ supportsVCard: true, vCardProperties }, {
      email: "",
      phones: [],
      addresses: [],
    }, FakeVCardPropertyEntry);
    assert.equal(vCardProperties.getAllEntries("email").length, 0);
    assert.equal(vCardProperties.getAllEntries("tel").length, 0);
    assert.equal(vCardProperties.getAllEntries("adr").length, 0);
    assert.equal(vCardProperties.getAllEntries("url").length, 1);
  });

  it("maps writes to legacy flat properties without touching department", () => {
    const card = makeFlatCard({ Department: "Keep Department", WorkPhone: "old" });
    helpers.applyContactFields(card, {
      phones: [{ type: "fax", number: " 555-0199 " }],
      addresses: [{ type: "home", street: "Home St", postalCode: "00-001" }],
      organization: "Flat Corp",
      title: "Manager",
      note: "flat note",
      birthday: "1980-04-15",
    }, FakeVCardPropertyEntry);

    assert.equal(card.stored.get("WorkPhone"), "");
    assert.equal(card.stored.get("FaxNumber"), "555-0199");
    assert.equal(card.stored.get("HomeAddress"), "Home St");
    assert.equal(card.stored.get("HomeZipCode"), "00-001");
    assert.equal(card.stored.get("Company"), "Flat Corp");
    assert.equal(card.stored.get("Department"), "Keep Department");
    assert.equal(card.stored.get("JobTitle"), "Manager");
    assert.equal(card.stored.get("Notes"), "flat note");
    assert.equal(card.stored.get("BirthYear"), "1980");
    assert.equal(card.stored.get("BirthMonth"), "04");
    assert.equal(card.stored.get("BirthDay"), "15");
  });

  it("rejects duplicate phone types on flat cards before mutating any fields", () => {
    const card = makeFlatCard({ WorkPhone: "old-number" });
    const result = helpers.applyContactFields(card, {
      displayName: "Changed Name",
      phones: [
        { type: "work", number: "555-0100" },
        { type: "work", number: "555-0101" },
      ],
    }, FakeVCardPropertyEntry);

    assert.match(result.error, /Non-vCard.*only one phone.*duplicate phone type "work"/);
    assert.equal(card.displayName, "Flat Contact");
    assert.equal(card.stored.get("WorkPhone"), "old-number");
  });

  it("rejects duplicate address types on flat cards before mutating any fields", () => {
    const card = makeFlatCard({ HomeAddress: "Old Home" });
    const result = helpers.applyContactFields(card, {
      firstName: "Changed",
      addresses: [
        { type: "home", street: "First Home" },
        { type: "home", street: "Second Home" },
      ],
    }, FakeVCardPropertyEntry);

    assert.match(result.error, /Non-vCard.*only one address.*duplicate address type "home"/);
    assert.equal(card.firstName, "Flat");
    assert.equal(card.stored.get("HomeAddress"), "Old Home");
  });
});

describe("contact email list", () => {
  function emailCard(entries) {
    return { supportsVCard: true, vCardProperties: new FakeVCardProperties(entries) };
  }

  function emailRows(card) {
    return plain(helpers.readContactFields(card).emails);
  }

  it("accepts plain addresses, internationalized ones included", () => {
    for (const address of ["a@example.com", "o'brien+tag@sub.example.co", "élodie@exemple.fr", "x@localhost"]) {
      assert.equal(helpers.isValidContactEmailAddress(address), true, address);
    }
  });

  it("rejects names, lists, whitespace and invisible characters", () => {
    for (const address of [
      "",
      "no-at.example.com",
      "@example.com",
      "a@",
      "a@@example.com",
      "a@b@example.com",
      "Ada <ada@example.com>",
      "a@example.com, b@example.com",
      "a@example.com;b@example.com",
      "a b@example.com",
      "a@example..com",
      "a@-example.com",
      ".a@example.com",
      "a..b@example.com",
      "a\u202e@example.com",
      "a\u200b@example.com",
      "a\n@example.com",
      `${"a".repeat(65)}@example.com`,
      `a@${"b".repeat(250)}.com`,
    ]) {
      assert.equal(helpers.isValidContactEmailAddress(address), false, JSON.stringify(address));
    }
  });

  it("validates the emails payload", () => {
    assert.equal(helpers.validateContactEmails([
      { address: " a@example.com ", type: "work" },
      { address: "b@example.com", type: "other", primary: true },
    ]), null);
    assert.equal(helpers.validateContactEmails([]), null);
    assert.match(helpers.validateContactEmails("a@example.com"), /must be an array/);
    assert.match(helpers.validateContactEmails(
      Array.from({ length: 11 }, (_, i) => ({ address: `a${i}@example.com` }))
    ), /at most 10/);
    assert.match(helpers.validateContactEmails([null]), /emails\[0\] must be an object/);
    assert.match(helpers.validateContactEmails([{ address: "a@example.com", label: "x" }]), /Unknown emails\[0\] property: label/);
    assert.match(helpers.validateContactEmails([{ address: "Ada <a@example.com>" }]), /emails\[0\]\.address/);
    assert.match(helpers.validateContactEmails([{ type: "work" }]), /emails\[0\]\.address/);
    assert.match(helpers.validateContactEmails([
      { address: "a@example.com" },
      { address: "A@Example.com" },
    ]), /emails\[1\]\.address is listed twice/);
    assert.match(helpers.validateContactEmails([{ address: "a@example.com", type: "cell" }]), /emails\[0\]\.type/);
    assert.match(helpers.validateContactEmails([{ address: "a@example.com", primary: "yes" }]), /primary must be a boolean/);
    assert.match(helpers.validateContactEmails([
      { address: "a@example.com", primary: true },
      { address: "b@example.com", primary: true },
    ]), /At most one/);
  });

  it("requires email and emails to agree on the primary", () => {
    const emails = [{ address: "a@example.com" }, { address: "b@example.com", primary: true }];
    assert.equal(helpers.validateContactFields({ email: "B@example.com", emails }), null);
    assert.match(helpers.validateContactFields({ email: "a@example.com", emails }), /email must match/);
    assert.equal(helpers.validateContactFields({ email: "", emails: [] }), null);
    assert.match(helpers.validateContactFields({ emails: [] }, true), /non-empty contact field/);
    assert.equal(helpers.validateContactFields({ emails: [{ address: "a@example.com" }] }, true), null);
  });

  it("moves the flagged primary to the front, else keeps the first", () => {
    assert.deepEqual(plain(helpers.orderContactEmails([
      { address: "a@example.com" },
      { address: " b@example.com ", type: "home", primary: true },
      { address: "c@example.com" },
    ]).map(item => item.address)), ["b@example.com", "a@example.com", "c@example.com"]);
    assert.deepEqual(plain(helpers.orderContactEmails([
      { address: "a@example.com" },
      { address: "b@example.com", primary: false },
    ]).map(item => item.address)), ["a@example.com", "b@example.com"]);
  });

  it("reads EMAIL entries in Thunderbird's preference order", () => {
    const card = emailCard([
      new FakeVCardPropertyEntry("email", { type: "work" }, "text", "first@example.com"),
      new FakeVCardPropertyEntry("email", { pref: "2" }, "text", "second@example.com"),
      new FakeVCardPropertyEntry("email", { type: ["internet", "x-school"] }, "text", " third@example.com "),
      new FakeVCardPropertyEntry("email", { pref: "1", type: "HOME" }, "text", "pref@example.com"),
      new FakeVCardPropertyEntry("email", {}, "text", ""),
    ]);
    assert.deepEqual(emailRows(card), [
      { address: "pref@example.com", type: "home", primary: true },
      { address: "second@example.com" },
      { address: "first@example.com", type: "work" },
      { address: "third@example.com" },
    ]);
  });

  it("writes a new list with PREF on the primary and TYPE on typed entries", () => {
    const card = emailCard([]);
    const result = helpers.applyContactFields(card, {
      emails: [
        { address: "work@example.com", type: "work" },
        { address: "home@example.com", type: "home", primary: true },
        { address: "plain@example.com", type: "other" },
      ],
    }, FakeVCardPropertyEntry);
    assert.equal(result, null);
    assert.deepEqual(card.vCardProperties.getAllEntries("email").map(entry => ({
      params: plain(entry.params),
      type: entry.type,
      value: entry.value,
    })), [
      { params: { type: "home", pref: "1" }, type: "text", value: "home@example.com" },
      { params: { type: "work" }, type: "text", value: "work@example.com" },
      { params: {}, type: "text", value: "plain@example.com" },
    ]);
    assert.deepEqual(emailRows(card), [
      { address: "home@example.com", type: "home", primary: true },
      { address: "work@example.com", type: "work" },
      { address: "plain@example.com" },
    ]);
  });

  it("replaces the list while keeping the entries, parameters and other properties it retains", () => {
    const oldPrimaryParams = { pref: "1", type: ["INTERNET", "WORK"], group: "item1" };
    const oldPrimary = new FakeVCardPropertyEntry("email", oldPrimaryParams, "text", "old.primary@example.com");
    const keptParams = { type: ["INTERNET", "pref"], "x-custom": "keep" };
    const kept = new FakeVCardPropertyEntry("email", keptParams, "text", "Kept@Example.com");
    const dropped = new FakeVCardPropertyEntry("email", { type: "home" }, "text", "dropped@example.com");
    const label = new FakeVCardPropertyEntry("x-ablabel", { group: "item1" }, "text", "Office");
    const tel = new FakeVCardPropertyEntry("tel", { type: "cell" }, "text", "+1 555 0100");
    const note = new FakeVCardPropertyEntry("note", {}, "text", "keep this note");
    const card = emailCard([oldPrimary, tel, kept, dropped, label, note]);

    const result = helpers.applyContactFields(card, {
      emails: [
        { address: "old.primary@example.com" },
        { address: "kept@example.com", type: "home", primary: true },
        { address: "added@example.com", type: "work" },
      ],
    }, FakeVCardPropertyEntry);

    assert.equal(result, null);
    const emails = card.vCardProperties.getAllEntries("email");
    assert.deepEqual(emails, [kept, oldPrimary, emails[2]]);
    assert.equal(kept.value, "kept@example.com");
    assert.strictEqual(kept.params, keptParams);
    assert.deepEqual(plain(kept.params), { type: ["INTERNET", "pref", "home"], "x-custom": "keep", pref: "1" });
    assert.strictEqual(oldPrimary.params, oldPrimaryParams);
    assert.deepEqual(plain(oldPrimary.params), { type: ["INTERNET", "WORK"], group: "item1" });
    assert.equal(emails[2].value, "added@example.com");
    assert.deepEqual(plain(emails[2].params), { type: "work" });
    assert.ok(!card.vCardProperties.entries.includes(dropped));
    for (const entry of [tel, label, note]) {
      assert.ok(card.vCardProperties.entries.includes(entry));
    }
    assert.equal(tel.value, "+1 555 0100");
    assert.equal(note.value, "keep this note");
    assert.deepEqual(emailRows(card), [
      { address: "kept@example.com", type: "home", primary: true },
      { address: "old.primary@example.com", type: "work" },
      { address: "added@example.com", type: "work" },
    ]);
  });

  it("drops a vCard 3 TYPE=PREF from secondary addresses and clears work/home with other", () => {
    const first = new FakeVCardPropertyEntry("email", { pref: "1" }, "text", "first@example.com");
    const second = new FakeVCardPropertyEntry("email", { type: ["pref", "work"] }, "text", "second@example.com");
    const card = emailCard([first, second]);
    helpers.applyContactFields(card, {
      emails: [{ address: "first@example.com" }, { address: "second@example.com", type: "other" }],
    }, FakeVCardPropertyEntry);
    assert.deepEqual(card.vCardProperties.getAllEntries("email"), [first, second]);
    assert.deepEqual(plain(first.params), { pref: "1" });
    assert.deepEqual(plain(second.params), {});
  });

  it("leaves an unchanged list where it is", () => {
    const first = new FakeVCardPropertyEntry("email", { pref: "1", type: "work" }, "text", "first@example.com");
    const tel = new FakeVCardPropertyEntry("tel", {}, "text", "555");
    const second = new FakeVCardPropertyEntry("email", { type: "home" }, "text", "second@example.com");
    const card = emailCard([first, tel, second]);
    helpers.applyContactFields(card, {
      emails: [{ address: "first@example.com", primary: true }, { address: "second@example.com" }],
    }, FakeVCardPropertyEntry);
    assert.deepEqual(card.vCardProperties.entries, [first, tel, second]);
    assert.deepEqual(plain(first.params), { pref: "1", type: "work" });
    assert.deepEqual(plain(second.params), { type: "home" });
  });

  it("clears every address with []", () => {
    const card = emailCard([
      new FakeVCardPropertyEntry("email", { pref: "1" }, "text", "a@example.com"),
      new FakeVCardPropertyEntry("email", {}, "text", "b@example.com"),
      new FakeVCardPropertyEntry("fn", {}, "text", "Name"),
    ]);
    helpers.applyContactFields(card, { emails: [] }, FakeVCardPropertyEntry);
    assert.equal(card.vCardProperties.getAllEntries("email").length, 0);
    assert.equal(card.vCardProperties.getAllEntries("fn").length, 1);
  });

  it("gives emails precedence over the matching email field", () => {
    const card = emailCard([]);
    let primaryEmailWrites = 0;
    Object.defineProperty(card, "primaryEmail", {
      get() { return ""; },
      set() { primaryEmailWrites++; },
    });
    helpers.applyContactFields(card, {
      email: "b@example.com",
      emails: [{ address: "a@example.com" }, { address: "b@example.com", primary: true }],
    }, FakeVCardPropertyEntry);
    assert.equal(primaryEmailWrites, 0);
    assert.deepEqual(emailRows(card).map(email => email.address), ["b@example.com", "a@example.com"]);
  });

  it("maps up to two addresses to PrimaryEmail/SecondEmail on flat cards", () => {
    const card = makeFlatCard({ SecondEmail: "old.second@example.com" });
    assert.equal(helpers.applyContactFields(card, {
      emails: [{ address: "one@example.com" }, { address: "two@example.com", primary: true }],
    }, FakeVCardPropertyEntry), null);
    assert.equal(card.primaryEmail, "two@example.com");
    assert.equal(card.stored.get("SecondEmail"), "one@example.com");

    helpers.applyContactFields(card, { emails: [{ address: "only@example.com" }] }, FakeVCardPropertyEntry);
    assert.equal(card.primaryEmail, "only@example.com");
    assert.equal(card.stored.get("SecondEmail"), "");
  });

  it("refuses what flat cards cannot store before mutating them", () => {
    const card = makeFlatCard();
    const three = helpers.applyContactFields(card, {
      displayName: "Changed",
      emails: [{ address: "a@example.com" }, { address: "b@example.com" }, { address: "c@example.com" }],
    }, FakeVCardPropertyEntry);
    assert.match(three.error, /at most two email addresses/);
    const typed = helpers.applyContactFields(card, {
      emails: [{ address: "a@example.com", type: "work" }],
    }, FakeVCardPropertyEntry);
    assert.match(typed.error, /do not store an email type/);
    assert.equal(card.displayName, "Flat Contact");
    assert.equal(card.primaryEmail, "flat@example.com");
  });

  it("does not synthesize a display name when emails are given", () => {
    assert.equal(helpers.shouldSynthesizePhoneDisplayName({
      emails: [{ address: "a@example.com" }],
      phones: [{ type: "home", number: "555-0100" }],
    }), false);
  });
});

describe("phone-only display name synthesis", () => {
  it("synthesizes only for a truly phone-only payload", () => {
    assert.equal(helpers.shouldSynthesizePhoneDisplayName({
      phones: [{ type: "home", number: "555-0100" }],
    }), true);
    assert.equal(helpers.shouldSynthesizePhoneDisplayName({
      displayName: "Ada",
      phones: [{ type: "home", number: "555-0100" }],
    }), false);
    assert.equal(helpers.shouldSynthesizePhoneDisplayName({
      organization: "Example Corp",
      phones: [{ type: "home", number: "555-0100" }],
    }), false);
    assert.equal(helpers.shouldSynthesizePhoneDisplayName({
      phones: [{ type: "home", number: "555-0100" }],
      addresses: [{ type: "home", city: "Warsaw" }],
    }), false);
  });
});

describe("contact tool wiring", () => {
  const apiSource = fs.readFileSync(
    path.resolve(__dirname, "../extension/mcp_server/api.js"),
    "utf8"
  );

  it("defines getContact as a UID-based read tool", () => {
    const start = apiSource.indexOf('name: "getContact"');
    const end = apiSource.indexOf('name: "createContact"', start);
    assert.ok(start >= 0 && end > start, "getContact tool definition missing");
    const definition = apiSource.slice(start, end);
    assert.match(definition, /group: "contacts", crud: "read"/);
    assert.match(definition, /contactId: \{ type: "string"/);
    assert.match(definition, /required: \["contactId"\]/);
  });

  it("passes emails through to createContact and updateContact", () => {
    assert.match(apiSource, /return createContact\(args\.email, args\.emails, args\.displayName,/);
    assert.match(apiSource, /return updateContact\(args\.contactId, args\.email, args\.emails, args\.displayName,/);
  });

  it("dispatches getContact through the existing UID lookup and shared formatter", () => {
    assert.match(apiSource, /case "getContact":\s*return getContact\(args\.contactId\);/);
    const start = apiSource.indexOf("function getContact(contactId)");
    const end = apiSource.indexOf("function createContact(", start);
    const handler = apiSource.slice(start, end);
    assert.match(handler, /findContactByUID\(contactId\)/);
    assert.match(handler, /formatContact\(found\.card, found\.book\)/);
  });

  it("uses the shared full-contact formatter in searchContacts", () => {
    assert.match(apiSource, /const contact = formatContact\(card, book\);/);
    assert.match(apiSource, /\.\.\.contact\.emails\.map\(e => e\.address\)/);
    assert.match(apiSource, /if \(card\.isMailList\) continue;\s*if \(card\.UID === contactId\)/);
  });
});
