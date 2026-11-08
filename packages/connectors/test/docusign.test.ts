import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, docusignDocMock, synthetic, testPipeline, type DocusignMockData, type DocusignMockEnvelope } from "@karatos/connector-testkit";
import {
  DOCUSIGN_ACCOUNT_HOSTS,
  DOCUSIGN_MAX_HMAC_KEYS,
  DOCUSIGN_OVERLAP_MS,
  DOCUSIGN_PAGE_SIZE,
  DOCUSIGN_RECIPIENT_ROLES,
  DOCUSIGN_SCOPES,
  DOCUSIGN_STALE_DELIVERY_MS,
  DOCUSIGN_WRITES,
  DocusignApiError,
  DocusignConfigError,
  agreementKind,
  checkCustomerRefKey,
  docusignBaseUri,
  docusignClient,
  docusignConnectEvents,
  docusignConnector,
  docusignEnvelopeEvents,
  docusignGuid,
  docusignPrivateKey,
  docusignRecipients,
  docusignSignatures,
  docusignTime,
  formCustomerRef,
  parseDocusignCursor,
  verifyDocusignConnect,
  type DocusignClient,
  type DocusignCursor,
  type DocusignOptions,
  type EnvelopeQuery,
} from "../src/index.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const SINCE = "2021-11-08T12:00:00.000Z";
const KEY = "k".repeat(64);
const noSleep = async () => {};
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PEM_B64 = Buffer.from(PEM).toString("base64");

const guid = (c: string, tail = "") => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${(c.repeat(12) + tail).slice(tail.length)}`;
const APP = guid("a");
const USER = guid("b");
const ACCOUNT = guid("c");
const env = (tag: string) => guid("e", tag);
const E = { consign: env("1"), memo: env("2"), old: env("3"), out: env("4"), bad: env("5"), voided: env("6") };
/** Docusign writes seven decimal places. */
const ds = (iso: string) => iso.replace(/\.(\d{3})Z$/, ".$10000Z");
const ref = (email: string) => formCustomerRef(KEY, "email", email);

const signer = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  recipientId: String(n),
  recipientIdGuid: guid("9", String(n)),
  name: synthetic.name(n),
  email: synthetic.email(n),
  status,
  routingOrder: String(n),
  ...extra,
});

function envelope(id: string, subject: string, status: string, changed: string, extra: Partial<DocusignMockEnvelope> = {}): DocusignMockEnvelope {
  return {
    envelopeId: id,
    status,
    emailSubject: subject,
    emailBlurb: "Test Customer, please sign the attached agreement",
    createdDateTime: ds("2026-10-01T09:00:00.000Z"),
    sentDateTime: ds("2026-10-01T09:05:00.000Z"),
    statusChangedDateTime: ds(changed),
    lastModifiedDateTime: ds(changed),
    documentsUri: `/envelopes/${id}/documents`,
    sender: { userName: "Test Staff", email: "staff@example.test" },
    recipients: {
      signers: [signer(1, status === "completed" ? "completed" : "sent", status === "completed" ? { signedDateTime: ds(changed), deliveredDateTime: ds("2026-10-02T09:00:00.000Z") } : {})],
      carbonCopies: [{ recipientId: "9", name: "Test Staff", email: "staff@example.test", status: "completed", routingOrder: "2" }],
      recipientCount: "2",
      currentRoutingOrder: "1",
    },
    ...extra,
  };
}

function account(extra: Partial<DocusignMockData> = {}): DocusignMockData {
  return {
    integrationKey: APP,
    userId: USER,
    accountId: ACCOUNT,
    publicKey: keys.publicKey,
    envelopes: [
      envelope(E.consign, "Please sign: Consignment agreement for Test Customer 1", "completed", "2026-11-01T10:00:00.000Z"),
      envelope(E.memo, "Memo agreement", "sent", "2026-10-20T10:00:00.000Z"),
      envelope(E.old, "Appraisal", "completed", "2020-02-01T09:00:00.000Z"),
      envelope(E.bad, "Custom design order", "sent", "2026-10-21T10:00:00.000Z", { statusChangedDateTime: "2026-10-21 10:00:00Z", lastModifiedDateTime: "soon", createdDateTime: ds("2026-08-01T09:00:00.000Z"), sentDateTime: undefined }),
    ],
    ...extra,
  };
}

function connector(data: DocusignMockData, options: Partial<DocusignOptions> = {}) {
  const mock = docusignDocMock(data);
  const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM_B64, environment: "developer", customerKey: KEY, now: () => NOW, fetch: mock.fetch, sleep: noSleep, ...options });
  return { c, mock };
}

const clientOptions = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => ({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, environment: "developer" as const, fetch, sleep: noSleep, now: () => NOW, ...extra });

/** A fetch that answers each request from a list, recording what was sent. */
function scripted(responses: Response[]) {
  const sent: { url: URL; init: RequestInit }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const TOKEN_OK = () => json(200, { access_token: `eyJ0eXAi.${"t".repeat(40)}`, token_type: "Bearer", expires_in: 3600 });
const USERINFO = (base = "https://demo.docusign.net") => json(200, { sub: USER, accounts: [{ account_id: ACCOUNT.toUpperCase(), base_uri: base }] });
const LIST = (envelopes: unknown[] | undefined, total = envelopes?.length ?? 0) => json(200, { resultSetSize: String(envelopes?.length ?? 0), totalSetSize: String(total), ...(envelopes ? { envelopes } : {}) });
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const reads = (mock: { fetch: { calls: { method: string; url: string }[] } }) => mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`);
const envelopeQueries = (mock: { fetch: { calls: { method: string; url: string }[] } }) => mock.fetch.calls.map((c) => new URL(c.url)).filter((u) => u.pathname.endsWith("/envelopes"));

async function batches(iterable: AsyncIterable<{ events: unknown[]; cursor: string | null }>) {
  const out: { events: { type: string; occurredAt?: string; idempotencyKey: string; payload: Record<string, unknown> }[]; cursor: string | null }[] = [];
  for await (const b of iterable) out.push(b as (typeof out)[number]);
  return out;
}
const ids = (out: Awaited<ReturnType<typeof batches>>) => out.flatMap((b) => b.events).map((e) => String(e.payload.agreementId).split(":")[2]);
const cursorOf = (out: Awaited<ReturnType<typeof batches>>, i = -1) => parseDocusignCursor(out.at(i)!.cursor)!;

describe("docusignTime, docusignGuid and docusignBaseUri", () => {
  it("reads Docusign's seven-decimal times as UTC", () => {
    expect(docusignTime("2026-11-01T10:00:00.1234567Z")).toBe("2026-11-01T10:00:00.123Z");
    expect(docusignTime("2026-11-01T10:00:00Z")).toBe("2026-11-01T10:00:00.000Z");
    expect(docusignTime("2026-11-01T10:00:00.5-05:00")).toBe("2026-11-01T15:00:00.500Z");
    for (const bad of ["2026-11-01", "2026-11-01T10:00Z", "2026-11-01T10:00:00", " 2026-11-01T10:00:00Z", "2026-11-01T10:00:00.12345678Z", "2026-13-01T10:00:00Z", "2026-11-01T10:00:00+0500", 1_700_000_000, null]) expect(docusignTime(bad), String(bad)).toBeUndefined();
  });

  it("reads GUIDs in lowercase and turns down anything else", () => {
    expect(docusignGuid(ACCOUNT.toUpperCase())).toBe(ACCOUNT);
    expect(docusignGuid(` ${ACCOUNT} `)).toBe(ACCOUNT);
    for (const bad of ["", ACCOUNT.replace(/-/g, ""), `${ACCOUNT}x`, `x${ACCOUNT}`, ACCOUNT.replace("c", "g"), "12345", 5, null]) expect(docusignGuid(bad), String(bad)).toBeUndefined();
  });

  it("keeps an account's API address only when it is an https docusign.net address", () => {
    expect(docusignBaseUri("https://demo.docusign.net")).toBe("https://demo.docusign.net");
    expect(docusignBaseUri("https://na3.docusign.net/")).toBe("https://na3.docusign.net");
    expect(docusignBaseUri("https://eu.a.docusign.net")).toBe("https://eu.a.docusign.net");
    for (const bad of [
      "http://demo.docusign.net",
      "https://docusign.net",
      "https://demo.docusign.net.example.test",
      "https://demodocusign.net",
      "https://evil.example/demo.docusign.net",
      "https://demo.docusign.net:8443",
      "https://user:pw@demo.docusign.net",
      "https://demo.docusign.net/restapi",
      "https://demo.docusign.net/?x=1",
      "https://demo.docusign.net/#x",
      "https://DEMO.docusign.net".replace("DEMO", "de_mo"),
      `https://${"a".repeat(200)}.docusign.net`,
      "not a url",
      5,
    ])
      expect(docusignBaseUri(bad), String(bad)).toBeUndefined();
  });
});

describe("docusignPrivateKey", () => {
  it("reads an RSA key as Docusign gives it, with escaped line breaks, or base64-encoded", () => {
    expect(docusignPrivateKey(PEM).asymmetricKeyType).toBe("rsa");
    expect(docusignPrivateKey(` ${PEM.replace(/\n/g, "\\n")} `).asymmetricKeyType).toBe("rsa");
    expect(docusignPrivateKey(PEM_B64).asymmetricKeyType).toBe("rsa");
    const rsa = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(docusignPrivateKey(rsa).asymmetricKeyType).toBe("rsa");
  });

  it("turns down anything that isn't an RSA private key, without echoing it", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    for (const bad of [undefined, "", "not a key", ec, pub, Buffer.from("x".repeat(200)).toString("base64"), [["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), "xxxx", ["-----END", "PRIVATE", "KEY-----"].join(" ")].join("\n"), "A".repeat(99), `${PEM_B64}!`]) {
      const error = (() => {
        try {
          docusignPrivateKey(bad);
          return undefined;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error, String(bad).slice(0, 30)).toBeInstanceOf(DocusignConfigError);
      expect(error!.message).toMatch(/DOCUSIGN_PRIVATE_KEY/);
      if (bad && bad.length > 5) expect(error!.message).not.toContain(bad.slice(0, 20));
    }
  });
});

describe("agreementKind", () => {
  it("reads the kind of agreement from its subject, first rule first", () => {
    const cases: [string, string][] = [
      ["Please sign: Consignment agreement", "consignment"],
      ["Consigned goods", "consignment"],
      ["Memo for 2 rings", "memo"],
      ["Memorial Day bill of sale", "sale"],
      ["Memorandum agreement", "memo"],
      ["Appraisal for insurance", "appraisal"],
      ["Valuation", "appraisal"],
      ["Custom engagement ring", "custom_order"],
      ["Bespoke design", "custom_order"],
      ["Commissioned piece", "custom_order"],
      ["Repair authorization", "repair"],
      ["Ring resizing", "repair"],
      ["We buy gold: seller agreement", "purchase"],
      ["Gold buying form", "purchase"],
      ["Buy-back terms", "purchase"],
      ["Layaway plan", "layaway"],
      ["Payment plan", "layaway"],
      ["Bill of sale", "sale"],
      ["Sales agreement", "sale"],
      ["Purchase agreement", "sale"],
      ["Offer letter", "employment"],
      ["Employee handbook", "employment"],
      ["W-4", "employment"],
      ["NDA", "confidentiality"],
      ["Non-disclosure", "confidentiality"],
      ["Wholesale vendor terms", "vendor"],
      ["Consignment memo", "consignment"],
      ["Hello", "other"],
      ["", "other"],
    ];
    for (const [subject, kind] of cases) expect(agreementKind(subject), subject).toBe(kind);
    expect(agreementKind(undefined)).toBe("other");
    expect(agreementKind(5)).toBe("other");
    // Only the start of a long subject is read.
    expect(agreementKind(`${"x ".repeat(300)}consignment`)).toBe("other");
  });
});

describe("docusignRecipients", () => {
  it("keeps each recipient's role, order, status and times, and only a keyed reference for their address", () => {
    const people = docusignRecipients(
      {
        signers: [signer(1, "completed", { signerEmail: synthetic.email(8), signedDateTime: ds("2026-11-01T10:00:00.000Z"), deliveredDateTime: ds("2026-10-31T10:00:00.000Z"), sentDateTime: ds("2026-10-30T10:00:00.000Z"), declinedReason: "Test Customer changed their mind", phoneNumber: "+1 212 555 0101" })],
        inPersonSigners: [{ recipientId: 2, email: "staff@example.test", hostEmail: "staff@example.test", hostName: "Test Staff", signerName: synthetic.name(2), signerEmail: synthetic.email(2), status: "SIGNED", routingOrder: 1 }],
        carbonCopies: [{ recipientId: "9", email: " Staff@Example.Test ", status: "completed", routingOrder: "2" }],
        witnesses: [{ recipientId: "../x", email: "not an address", status: "declined", declinedDateTime: ds("2026-11-02T10:00:00.000Z"), routingOrder: "-1" }],
        editors: "nope",
        unknownList: [signer(5, "sent")],
        recipientCount: "4",
      },
      KEY,
    );
    expect(people).toEqual([
      { role: "signer", recipientId: "1", routingOrder: 1, status: "completed", sentAt: "2026-10-30T10:00:00.000Z", deliveredAt: "2026-10-31T10:00:00.000Z", signedAt: "2026-11-01T10:00:00.000Z", declinedAt: undefined, customerRefs: [ref("customer1@example.test")] },
      { role: "in_person_signer", recipientId: "2", routingOrder: 1, status: "signed", sentAt: undefined, deliveredAt: undefined, signedAt: undefined, declinedAt: undefined, customerRefs: [ref("customer2@example.test")] },
      { role: "witness", recipientId: undefined, routingOrder: undefined, status: "declined", sentAt: undefined, deliveredAt: undefined, signedAt: undefined, declinedAt: "2026-11-02T10:00:00.000Z", customerRefs: [] },
      { role: "copy", recipientId: "9", routingOrder: 2, status: "completed", sentAt: undefined, deliveredAt: undefined, signedAt: undefined, declinedAt: undefined, customerRefs: [ref("staff@example.test")] },
    ]);
    const text = JSON.stringify(people);
    for (const word of ["Test Customer", "Test Staff", "@", "555", "changed their mind"]) expect(text).not.toContain(word);
  });

  it("names every role in Docusign's order, and reads odd values as empty", () => {
    expect(Object.keys(DOCUSIGN_RECIPIENT_ROLES)).toEqual(["signers", "inPersonSigners", "witnesses", "notaries", "agents", "editors", "intermediaries", "carbonCopies", "certifiedDeliveries", "seals", "participants"]);
    expect(docusignRecipients(null, KEY)).toEqual([]);
    expect(docusignRecipients([signer(1, "sent")], KEY)).toEqual([]);
    const [odd] = docusignRecipients({ notaries: [{ recipientId: 1.5, status: "teleported", routingOrder: "12345" }, null, "x"] }, KEY);
    for (const order of ["1e3", " 1", "0x1", "1.0"]) expect(docusignRecipients({ signers: [{ routingOrder: order }] }, KEY)[0]!.routingOrder, order).toBeUndefined();
    expect(odd).toEqual({ role: "notary", recipientId: undefined, routingOrder: undefined, status: "unknown", sentAt: undefined, deliveredAt: undefined, signedAt: undefined, declinedAt: undefined, customerRefs: [] });
    expect(docusignRecipients({ signers: [{ recipientId: "x".repeat(101), routingOrder: 10_000 }, { recipientId: "x".repeat(100), routingOrder: 9999 }] }, KEY).map((r) => [r.recipientId, r.routingOrder])).toEqual([
      [undefined, undefined],
      ["x".repeat(100), 9999],
    ]);
  });

  it("keeps at most 100 recipients", () => {
    const many = docusignRecipients({ signers: Array.from({ length: 80 }, (_, i) => signer(i + 1, "sent")), carbonCopies: Array.from({ length: 40 }, (_, i) => signer(i + 100, "sent")) }, KEY);
    expect(many).toHaveLength(100);
    expect(many.filter((r) => r.role === "copy")).toHaveLength(20);
  });

  it("checks the customer reference key", () => {
    expect(() => docusignRecipients({ signers: [signer(1, "sent")] }, "short")).toThrow(/CUSTOMER_REF_KEY/);
    expect(checkCustomerRefKey(KEY)).toBe(KEY);
  });
});

describe("the Docusign normalizer", () => {
  const ctx = { receivedAt: RECEIVED, customerKey: KEY };

  it("makes an envelope an agreement with its kind, status, times and who has yet to sign, never its words", () => {
    const raw = envelope(E.memo, "Memo for Test Customer 1", "sent", "2026-10-20T10:00:00.000Z", {
      recipients: { signers: [signer(1, "delivered"), signer(2, "completed"), signer(3, "created")], inPersonSigners: [{ recipientId: "4", status: "signed" }], witnesses: [{ recipientId: "5", status: "declined" }], carbonCopies: [{ recipientId: "6", status: "sent", email: "staff@example.test" }], agents: [{ recipientId: "7", status: "sent" }] },
      completedDateTime: undefined,
      voidedDateTime: ds("2026-10-25T10:00:00.000Z"),
      declinedDateTime: ds("2026-10-24T10:00:00.000Z"),
      deliveredDateTime: ds("2026-10-02T10:00:00.000Z"),
      deletedDateTime: ds("2026-10-26T10:00:00.000Z"),
      customFields: { textCustomFields: [{ name: "Customer", value: "Test Customer 1" }] },
    });
    const [event] = docusignEnvelopeEvents(raw, ctx);
    expect(event).toMatchObject({ type: "agreement.updated", occurredAt: "2026-10-20T10:00:00.000Z", receivedAt: RECEIVED });
    expect(event!.payload).toEqual({
      agreementId: `docusign:envelope:${E.memo}`,
      kind: "memo",
      status: "sent",
      createdAt: "2026-10-01T09:00:00.000Z",
      sentAt: "2026-10-01T09:05:00.000Z",
      deliveredAt: "2026-10-02T10:00:00.000Z",
      declinedAt: "2026-10-24T10:00:00.000Z",
      voidedAt: "2026-10-25T10:00:00.000Z",
      deletedAt: "2026-10-26T10:00:00.000Z",
      statusChangedAt: "2026-10-20T10:00:00.000Z",
      signers: 5,
      signed: 2,
      awaitingSignature: 2,
      recipients: [
        { role: "signer", recipientId: "1", routingOrder: 1, status: "delivered", customerRefs: [ref("customer1@example.test")] },
        { role: "signer", recipientId: "2", routingOrder: 2, status: "completed", customerRefs: [ref("customer2@example.test")] },
        { role: "signer", recipientId: "3", routingOrder: 3, status: "created", customerRefs: [ref("customer3@example.test")] },
        { role: "in_person_signer", recipientId: "4", status: "signed", customerRefs: [] },
        { role: "witness", recipientId: "5", status: "declined", customerRefs: [] },
        { role: "agent", recipientId: "7", status: "sent", customerRefs: [] },
        { role: "copy", recipientId: "6", status: "sent", customerRefs: [ref("staff@example.test")] },
      ],
    });
    const text = JSON.stringify(event);
    for (const word of ["Test Customer", "Test Staff", "@", "please sign", "Memo for"]) expect(text).not.toContain(word);
    // A time a recipient doesn't have is left out, not written as empty.
    expect(Object.keys((event!.payload.recipients as object[])[0]!)).toEqual(["role", "recipientId", "routingOrder", "status", "customerRefs"]);
  });

  it("keys each version by what was read, so a replay is a duplicate and a change is new", () => {
    const one = envelope(E.memo, "Memo", "sent", "2026-10-20T10:00:00.000Z");
    const [a] = docusignEnvelopeEvents(one, ctx);
    const [b] = docusignEnvelopeEvents(structuredClone(one), { ...ctx, receivedAt: "2026-11-09T00:00:00.000Z" });
    expect(a!.idempotencyKey).toBe(b!.idempotencyKey);
    expect(a!.idempotencyKey).toMatch(new RegExp(`^docusign:envelope:${E.memo}:[0-9a-f]{16}$`));
    expect(a!.id).toBe(`docusign_${a!.idempotencyKey.slice("docusign:".length)}`);
    // A recipient signing without the envelope's status changing is a new version.
    const signed = { ...one, recipients: { signers: [signer(1, "completed")] } };
    expect(docusignEnvelopeEvents(signed, ctx)[0]!.idempotencyKey).not.toBe(a!.idempotencyKey);
    // Only what is kept counts: a new subject of the same kind, or a view that moves lastModified, is a duplicate.
    expect(docusignEnvelopeEvents({ ...one, emailSubject: "Memo, second copy", lastModifiedDateTime: ds("2026-10-21T10:00:00.000Z") }, ctx)[0]!.idempotencyKey).toBe(a!.idempotencyKey);
    expect(docusignEnvelopeEvents({ ...one, envelopeId: E.consign }, ctx)[0]!.idempotencyKey).not.toBe(a!.idempotencyKey.replace(E.memo, E.consign));
  });

  it("reads the change time from the status change, else the last change, and dead-letters one with neither", () => {
    const base = envelope(E.memo, "Memo", "sent", "2026-10-20T10:00:00.000Z");
    expect(docusignEnvelopeEvents({ ...base, statusChangedDateTime: undefined }, ctx)[0]!.occurredAt).toBe("2026-10-20T10:00:00.000Z");
    expect(docusignEnvelopeEvents({ ...base, statusChangedDateTime: "x", lastModifiedDateTime: ds("2026-10-21T10:00:00.000Z") }, ctx)[0]!.occurredAt).toBe("2026-10-21T10:00:00.000Z");
    expect(docusignEnvelopeEvents({ ...base, lastModifiedDateTime: ds("2026-10-22T10:00:00.000Z") }, ctx)[0]!.occurredAt).toBe("2026-10-20T10:00:00.000Z");
    const [dead] = docusignEnvelopeEvents({ ...base, statusChangedDateTime: "x", lastModifiedDateTime: undefined }, ctx);
    expect(dead!.occurredAt).toBeUndefined();
  });

  it("drops an envelope with no usable id, and reads odd fields as unknown or empty", () => {
    for (const bad of [null, [], "x", {}, { envelopeId: "../x" }, { envelopeId: E.memo.replace("e", "g") }]) expect(docusignEnvelopeEvents(bad, ctx), JSON.stringify(bad)).toEqual([]);
    const [odd] = docusignEnvelopeEvents({ envelopeId: E.memo.toUpperCase(), status: "Teleported", recipients: "nope" }, ctx);
    expect(odd!.payload).toEqual({ agreementId: `docusign:envelope:${E.memo}`, kind: "other", status: "unknown", signers: 0, signed: 0, awaitingSignature: 0, recipients: [] });
    expect(docusignEnvelopeEvents({ envelopeId: E.memo, status: "COMPLETED" }, ctx)[0]!.payload.status).toBe("completed");
    expect(docusignEnvelopeEvents({ envelopeId: E.memo }, ctx)[0]!.payload).not.toHaveProperty("status");
  });

  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(account());
  });
});

describe("the Docusign client", () => {
  it("checks its settings, naming them but never their values", () => {
    const fetch = (async () => json(500, {})) as typeof globalThis.fetch;
    expect(() => docusignClient(clientOptions(fetch, { integrationKey: "KaratOS" }))).toThrow(new DocusignConfigError("DOCUSIGN_INTEGRATION_KEY must be the app's integration key, a GUID"));
    expect(() => docusignClient(clientOptions(fetch, { userId: "viewer@example.test" }))).toThrow(new DocusignConfigError("DOCUSIGN_USER_ID must be the user's API user id, a GUID"));
    expect(() => docusignClient(clientOptions(fetch, { accountId: "12345" }))).toThrow(new DocusignConfigError("DOCUSIGN_ACCOUNT_ID must be the account's API account id, a GUID"));
    for (const environment of ["sandbox", "toString", "__proto__"]) expect(() => docusignClient(clientOptions(fetch, { environment })), environment).toThrow(new DocusignConfigError("DOCUSIGN_ENVIRONMENT must be production or developer"));
    expect(() => docusignClient(clientOptions(fetch, { privateKey: "x" }))).toThrow(/DOCUSIGN_PRIVATE_KEY/);
    expect(DOCUSIGN_ACCOUNT_HOSTS).toEqual({ production: "account.docusign.com", developer: "account-d.docusign.com" });
  });

  it("signs in with an RS256 JWT for signature impersonation only, and reads production by default", async () => {
    const { fetch, sent } = scripted([TOKEN_OK(), USERINFO("https://na3.docusign.net"), LIST([])]);
    const { environment: _, ...prod } = clientOptions(fetch, { userId: ` ${USER.toUpperCase()} `, integrationKey: APP.toUpperCase() });
    await docusignClient(prod).envelopes({ from: SINCE, orderBy: "status_changed", start: 0 });
    expect(sent.map((s) => `${s.init.method} ${s.url.origin}${s.url.pathname}`)).toEqual(["POST https://account.docusign.com/oauth/token", "GET https://account.docusign.com/oauth/userinfo", `GET https://na3.docusign.net/restapi/v2.1/accounts/${ACCOUNT}/envelopes`]);
    const form = new URLSearchParams(String(sent[0]!.init.body));
    expect([...form.keys()]).toEqual(["grant_type", "assertion"]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = NOW.getTime() / 1000;
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: APP, sub: USER, aud: "account.docusign.com", iat, exp: iat + 3600, scope: "signature impersonation" });
    expect(DOCUSIGN_SCOPES).toBe("signature impersonation");
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), keys.publicKey, Buffer.from(s, "base64url"))).toBe(true);
    expect(new Headers(sent[0]!.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    for (const later of sent.slice(1)) expect(new Headers(later.init.headers).get("authorization")).toBe(`Bearer eyJ0eXAi.${"t".repeat(40)}`);
    expect(JSON.stringify(sent.map((x) => x.init))).not.toContain("PRIVATE KEY");
  });

  it("asks for the account's envelopes with their recipients, oldest change first, with only the filters it built", async () => {
    const mock = docusignDocMock(account());
    const client = docusignClient(clientOptions(mock.fetch));
    const page = await client.envelopes({ from: SINCE, orderBy: "status_changed", start: 0 });
    expect(page.total).toBe(3);
    expect(page.data.map((e) => e.envelopeId)).toEqual([E.memo, E.bad, E.consign]);
    const open = await client.envelopes({ from: SINCE, status: ["sent", "delivered"], orderBy: "created", start: 1 });
    expect(open.data.map((e) => e.envelopeId)).toEqual([E.memo]);
    expect(open.total).toBe(2);
    const [first, second] = envelopeQueries(mock);
    expect(Object.fromEntries(first!.searchParams)).toEqual({ from_date: SINCE, include: "recipients", order_by: "status_changed", order: "asc", count: String(DOCUSIGN_PAGE_SIZE), start_position: "0" });
    expect(Object.fromEntries(second!.searchParams)).toEqual({ from_date: SINCE, status: "sent,delivered", include: "recipients", order_by: "created", order: "asc", count: "100", start_position: "1" });
    expect(reads(mock)).toEqual(["POST https://account-d.docusign.com/oauth/token", "GET https://account-d.docusign.com/oauth/userinfo", `GET https://demo.docusign.net/restapi/v2.1/accounts/${ACCOUNT}/envelopes`, `GET https://demo.docusign.net/restapi/v2.1/accounts/${ACCOUNT}/envelopes`]);
    expect(mock.signIns).toBe(1);
  });

  it("turns down times, positions, orders and statuses it didn't build before sending anything", async () => {
    const { fetch, sent } = scripted([]);
    const client = docusignClient(clientOptions(fetch));
    const bad: EnvelopeQuery[] = [
      { from: "2026-11-01", orderBy: "created", start: 0 },
      { from: "2026-11-01T10:00:00Z", orderBy: "created", start: 0 },
      { from: "2026-02-30T10:00:00.000Z", orderBy: "created", start: 0 },
      { from: `${SINCE}&status=any`, orderBy: "created", start: 0 },
      { from: SINCE, orderBy: "created", start: -1 },
      { from: SINCE, orderBy: "created", start: 1.5 },
      { from: SINCE, orderBy: "created", start: 1_000_001 },
      { from: SINCE, orderBy: "subject" as never, start: 0 },
      { from: SINCE, orderBy: "created", start: 0, status: [] },
      { from: SINCE, orderBy: "created", start: 0, status: ["completed" as never] },
    ];
    for (const query of bad) await expect(client.envelopes(query), JSON.stringify(query)).rejects.toThrow(DocusignApiError);
    expect(sent).toEqual([]);
    expect(DOCUSIGN_PAGE_SIZE).toBe(100);
  });

  it("finds the account's address among the user's accounts and checks it", async () => {
    const other = scripted([TOKEN_OK(), json(200, { accounts: [{ account_id: guid("d"), base_uri: "https://demo.docusign.net" }, "x"] })]);
    await expect(docusignClient(clientOptions(other.fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 })).rejects.toThrow(new DocusignConfigError("DOCUSIGN_USER_ID isn't a member of DOCUSIGN_ACCOUNT_ID: check both ids, and DOCUSIGN_ENVIRONMENT"));
    const none = scripted([TOKEN_OK(), json(200, { accounts: "nope" })]);
    await expect(docusignClient(clientOptions(none.fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 })).rejects.toThrow(DocusignConfigError);
    const evil = scripted([TOKEN_OK(), USERINFO("https://demo.docusign.net.example.test")]);
    await expect(docusignClient(clientOptions(evil.fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 })).rejects.toThrow("Docusign gave the account an API address that isn't an https docusign.net address");
    expect(evil.sent).toHaveLength(2);
    // The address is found once and kept.
    const kept = scripted([TOKEN_OK(), USERINFO(), LIST([]), LIST([])]);
    const client = docusignClient(clientOptions(kept.fetch));
    await client.envelopes({ from: SINCE, orderBy: "created", start: 0 });
    await client.envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(kept.sent.map((s) => s.url.pathname)).toEqual(["/oauth/token", "/oauth/userinfo", `/restapi/v2.1/accounts/${ACCOUNT}/envelopes`, `/restapi/v2.1/accounts/${ACCOUNT}/envelopes`]);
  });

  it("keeps a token until 15 minutes before it ends, and signs in again once when one is turned down", async () => {
    let at = NOW.getTime();
    const mock = docusignDocMock(account());
    const client = docusignClient(clientOptions(mock.fetch, { now: () => new Date(at) }));
    await client.envelopes({ from: SINCE, orderBy: "created", start: 0 });
    at += 44 * 60_000;
    await client.envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(mock.signIns).toBe(1);
    at += 2 * 60_000;
    await client.envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(mock.signIns).toBe(2);
    mock.revokeTokens();
    await client.envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(mock.signIns).toBe(3);
    // Turned down again after a new sign-in: the error stands.
    const twice = scripted([TOKEN_OK(), json(401, { errorCode: "USER_AUTHENTICATION_FAILED" }), TOKEN_OK(), json(401, {})]);
    await expect(docusignClient(clientOptions(twice.fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 })).rejects.toThrow(new DocusignApiError("Docusign turned down the access token for the user's accounts", 401));
    expect(twice.sent.map((s) => s.url.pathname)).toEqual(["/oauth/token", "/oauth/userinfo", "/oauth/token", "/oauth/userinfo"]);
  });

  it("uses the token's own lifetime, and a short one is asked for again each time", async () => {
    const { fetch, sent } = scripted([json(200, { access_token: `eyJ0eXAi.${"t".repeat(40)}`, expires_in: "600" }), USERINFO(), json(200, { access_token: `eyJ0eXAi.${"u".repeat(40)}`, expires_in: 600 }), LIST([])]);
    await docusignClient(clientOptions(fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(sent.map((s) => s.url.pathname)).toEqual(["/oauth/token", "/oauth/userinfo", "/oauth/token", `/restapi/v2.1/accounts/${ACCOUNT}/envelopes`]);
    const noLife = scripted([json(200, { access_token: `eyJ0eXAi.${"t".repeat(40)}` }), USERINFO(), LIST([])]);
    await docusignClient(clientOptions(noLife.fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(noLife.sent).toHaveLength(3);
  });

  it("says what to fix when the sign-in is turned down, without the key", async () => {
    const cases: [Response, string | RegExp, new (...args: never[]) => Error][] = [
      [json(400, { error: "consent_required" }), "Docusign says the user hasn't consented to the app: sign in once as DOCUSIGN_USER_ID through the consent link in docs/integrations/docusign.md", DocusignConfigError],
      [json(400, { error: "no_valid_keys_or_signatures" }), "Docusign turned down the sign-in: DOCUSIGN_PRIVATE_KEY isn't a key of the app named by DOCUSIGN_INTEGRATION_KEY", DocusignConfigError],
      [json(400, { error: "invalid_grant" }), "Docusign turned down the sign-in (invalid_grant): check DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID and DOCUSIGN_ENVIRONMENT", DocusignConfigError],
      [json(400, { error: "user_not_found" }), /\(user_not_found\)/, DocusignConfigError],
      [json(400, { error: "issuer_not_found" }), /\(issuer_not_found\)/, DocusignConfigError],
      [json(400, { error: "invalid_request <script>" }), "Docusign answered HTTP 400 to the sign-in", DocusignApiError],
      [json(503, { errorCode: "SERVICE_UNAVAILABLE" }), "Docusign answered HTTP 503 to the sign-in (SERVICE_UNAVAILABLE)", DocusignApiError],
      [new Response("<html>", { status: 502 }), "Docusign answered HTTP 502 to the sign-in", DocusignApiError],
      [json(200, { token_type: "Bearer" }), "Docusign's sign-in answer has no access token", DocusignApiError],
      [json(200, { access_token: "short" }), "Docusign's sign-in answer has no access token", DocusignApiError],
      [json(200, { access_token: `${"t".repeat(30)} x` }), "Docusign's sign-in answer has no access token", DocusignApiError],
      [json(200, "x"), "Docusign's sign-in answer has no access token", DocusignApiError],
    ];
    for (const [response, message, type] of cases) {
      const { fetch } = scripted([response]);
      const error = await failure(docusignClient(clientOptions(fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 }));
      expect(error, String(message)).toBeInstanceOf(type);
      if (typeof message === "string") expect(error.message).toBe(message);
      else expect(error.message).toMatch(message);
      expect(error.message).not.toContain("BEGIN");
    }
  });

  it("names Docusign's error code for a failed read, never its message", async () => {
    const cases: [Response, string, number][] = [
      [json(400, { errorCode: "USER_DOES_NOT_BELONG_TO_SPECIFIED_ACCOUNT", message: "Test Customer is not a member" }), "Docusign answered HTTP 400 for the account's envelopes (USER_DOES_NOT_BELONG_TO_SPECIFIED_ACCOUNT)", 400],
      [json(500, { errorCode: "x".repeat(81) }), "Docusign answered HTTP 500 for the account's envelopes", 500],
      [json(500, { errorCode: 5 }), "Docusign answered HTTP 500 for the account's envelopes", 500],
      [json(200, []), "Docusign answered the account's envelopes with a body that isn't a JSON object", 200],
      [new Response("not json", { status: 200 }), "Docusign answered the account's envelopes with a body that isn't a JSON object", 200],
      [json(200, { envelopes: "x" }), "Docusign answered the account's envelopes with a list that isn't one", 200],
    ];
    for (const [response, message, status] of cases) {
      const { fetch } = scripted([TOKEN_OK(), USERINFO(), response]);
      const error = await failure(docusignClient(clientOptions(fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 }));
      expect(error, message).toEqual(new DocusignApiError(message, status));
      expect((error as DocusignApiError).status).toBe(status);
      expect(error.message).not.toContain("Test Customer");
    }
  });

  it("reads a page with no envelopes, counts written as numbers or strings, and odd entries as empty", async () => {
    const cases: [Response, number, number][] = [
      [json(200, { resultSetSize: "0", totalSetSize: "0" }), 0, 0],
      [json(200, { envelopes: [{ envelopeId: E.memo }, "x", null], totalSetSize: 7 }), 3, 7],
      [json(200, { envelopes: [{ envelopeId: E.memo }], totalSetSize: "-1" }), 1, 1],
      [json(200, { envelopes: [{ envelopeId: E.memo }], totalSetSize: "1e3" }), 1, 1],
      [json(200, { envelopes: [{ envelopeId: E.memo }], totalSetSize: 1.5 }), 1, 1],
    ];
    for (const [response, length, total] of cases) {
      const { fetch } = scripted([TOKEN_OK(), USERINFO(), response]);
      const page = await docusignClient(clientOptions(fetch)).envelopes({ from: SINCE, orderBy: "created", start: 0 });
      expect(page.data).toHaveLength(length);
      expect(page.total).toBe(total);
      for (const e of page.data) expect(typeof e === "object" && e !== null && !Array.isArray(e)).toBe(true);
    }
  });

  it("waits out a 429 for Retry-After seconds, up to a minute, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const limited = (after?: string) => json(429, { errorCode: "HOURLY_APIINVOCATION_LIMIT_EXCEEDED" }, after === undefined ? {} : { "Retry-After": after });
    const { fetch } = scripted([TOKEN_OK(), USERINFO(), limited("3"), limited("600"), limited("soon"), LIST([])]);
    await docusignClient(clientOptions(fetch, { sleep })).envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(waits).toEqual([3000, 60_000, 4000]);
    waits.length = 0;
    const zero = scripted([TOKEN_OK(), USERINFO(), limited("0"), LIST([])]);
    await docusignClient(clientOptions(zero.fetch, { sleep })).envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(waits).toEqual([1000]);
    const tooMany = scripted([TOKEN_OK(), USERINFO(), limited(), limited()]);
    const error = await failure(docusignClient(clientOptions(tooMany.fetch, { sleep, rateLimitRetries: 1 })).envelopes({ from: SINCE, orderBy: "created", start: 0 }));
    expect(error).toEqual(new DocusignApiError("Docusign's rate limit stopped the account's envelopes (HOURLY_APIINVOCATION_LIMIT_EXCEEDED); runSync tries again later", 429));
    const quiet = scripted([TOKEN_OK(), USERINFO(), json(429, {})]);
    expect((await failure(docusignClient(clientOptions(quiet.fetch, { rateLimitRetries: 0 })).envelopes({ from: SINCE, orderBy: "created", start: 0 }))).message).toBe("Docusign's rate limit stopped the account's envelopes; runSync tries again later");
  });

  it("waits by doubling when Docusign gives no time", async () => {
    const waits: number[] = [];
    const { fetch } = scripted([TOKEN_OK(), USERINFO(), json(429, {}), json(429, {}), json(429, {}), LIST([])]);
    await docusignClient(clientOptions(fetch, { sleep: async (ms: number) => void waits.push(ms) })).envelopes({ from: SINCE, orderBy: "created", start: 0 });
    expect(waits).toEqual([1000, 2000, 4000]);
  });
});

describe("Docusign Connect", () => {
  const ctx = { receivedAt: RECEIVED, customerKey: KEY };
  const HMAC = ["h".repeat(43) + "=", "second-key-xxxxxxxxxxxxxxxxxxxx"];
  const sig = (key: string, body: string) => createHmac("sha256", Buffer.from(key, "utf8")).update(Buffer.from(body, "utf8")).digest("base64");
  const delivery = (extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
    event: "recipient-completed",
    apiVersion: "v2.1",
    uri: `/restapi/v2.1/accounts/${ACCOUNT}/envelopes/${E.memo}`,
    retryCount: 0,
    configurationId: 1,
    generatedDateTime: ds("2026-11-08T11:00:00.000Z"),
    data: { accountId: ACCOUNT, userId: USER, envelopeId: E.memo, recipientId: guid("9", "1"), envelopeSummary: envelope(E.memo, "Memo", "completed", "2026-11-08T10:59:00.000Z"), ...data },
    ...extra,
  });

  it("trusts a delivery signed with any of the configuration's keys, and nothing else", () => {
    const body = JSON.stringify(delivery());
    expect(verifyDocusignConnect(HMAC, body, [sig(HMAC[0]!, body)])).toEqual({ ok: true });
    expect(verifyDocusignConnect(HMAC, Buffer.from(body), ["x".repeat(43) + "=", ` ${sig(HMAC[1]!, body)} `])).toEqual({ ok: true });
    expect(verifyDocusignConnect([`"${HMAC[0]}"`], body, [sig(HMAC[0]!, body)])).toEqual({ ok: true });
    expect(verifyDocusignConnect(HMAC, `${body} `, [sig(HMAC[0]!, body)])).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyDocusignConnect(HMAC, body, [sig("another key xxxxxxxxxxxxx", body)])).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyDocusignConnect(HMAC, body, [createHmac("sha256", HMAC[0]!).update(body).digest("hex")])).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDocusignConnect(HMAC, body, [sig(HMAC[0]!, body).slice(0, -1)])).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDocusignConnect(HMAC, body, [])).toEqual({ ok: false, reason: "missing" });
    expect(verifyDocusignConnect([], body, [sig(HMAC[0]!, body)])).toEqual({ ok: false, reason: "missing" });
    expect(verifyDocusignConnect([" ", '""'], body, [sig(HMAC[0]!, body)])).toEqual({ ok: false, reason: "missing" });
    // A key spelled with quotes signs the same as without them.
    expect(verifyDocusignConnect(['"a"'], body, [sig("a", body)])).toEqual({ ok: true });
  });

  it("reads the numbered signature headers, up to 100", () => {
    const headers = new Headers({ "X-Docusign-Signature-1": "a", "x-docusign-signature-2": "b", "X-DocuSign-Signature-100": "c", "X-Docusign-Signature-101": "d", "X-Docusign-Signature-0": "e", "X-Docusign-Signature": "f" });
    expect(docusignSignatures((name) => headers.get(name))).toEqual(["a", "b", "c"]);
    expect(docusignSignatures(() => undefined)).toEqual([]);
    expect(docusignSignatures(() => "")).toEqual([]);
    expect(DOCUSIGN_MAX_HMAC_KEYS).toBe(100);
  });

  it("makes a verified delivery the same agreement event the sync makes", () => {
    const body = delivery();
    const [event] = docusignConnectEvents(body, ACCOUNT.toUpperCase(), ctx, NOW);
    expect(event).toEqual(docusignEnvelopeEvents(body.data.envelopeSummary, ctx)[0]);
    expect(event!.payload.status).toBe("completed");
    expect(docusignConnectEvents({ ...body, event: "envelope-voided" }, ACCOUNT, ctx, NOW)).toHaveLength(1);
  });

  it("gives no events for a stale, foreign, mismatched or unreadable delivery", () => {
    const stale = ds(new Date(NOW.getTime() - DOCUSIGN_STALE_DELIVERY_MS - 1000).toISOString());
    const edge = ds(new Date(NOW.getTime() - DOCUSIGN_STALE_DELIVERY_MS).toISOString());
    expect(docusignConnectEvents(delivery({ generatedDateTime: edge }), ACCOUNT, ctx, NOW)).toHaveLength(1);
    const none: unknown[] = [
      delivery({ generatedDateTime: stale }),
      delivery({ generatedDateTime: "yesterday" }),
      delivery({ generatedDateTime: undefined }),
      delivery({ event: "template-created" }),
      delivery({ event: "envelope-" }),
      delivery({ event: `envelope-${"x".repeat(41)}` }),
      delivery({ event: 5 }),
      delivery({ data: "x" }),
      delivery({}, { accountId: guid("d") }),
      delivery({}, { accountId: undefined }),
      delivery({}, { envelopeId: E.consign }),
      delivery({}, { envelopeId: undefined }),
      delivery({}, { envelopeSummary: undefined }),
      delivery({}, { envelopeSummary: { ...envelope(E.memo, "Memo", "sent", "2026-11-08T10:59:00.000Z"), envelopeId: "x" } }),
      null,
      [],
      "x",
    ];
    for (const body of none) expect(docusignConnectEvents(body, ACCOUNT, ctx, NOW), JSON.stringify(body)?.slice(0, 80)).toEqual([]);
    expect(docusignConnectEvents(delivery(), "not-an-id", ctx, NOW)).toEqual([]);
    expect(docusignConnectEvents(delivery({}, { accountId: "x" }), "not-an-id", ctx, NOW)).toEqual([]);
    expect(DOCUSIGN_STALE_DELIVERY_MS).toBe(24 * 3_600_000);
  });

  it("stores a replayed delivery once", async () => {
    const { c } = connector(account());
    const t = testPipeline();
    const body = delivery();
    const ingest = (events: unknown[]) => Promise.all(events.map((e) => t.pipeline.ingest({ ...(e as object), organizationId: TEST_ORG, source: "docusign" })));
    const first = await ingest(c.handleWebhook!(body));
    const again = await ingest(c.handleWebhook!(structuredClone(body)));
    expect(first).toHaveLength(1);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ duplicate: true });
    expect(first[0]).toMatchObject({ duplicate: false });
  });
});

describe("parseDocusignCursor", () => {
  const ok: DocusignCursor = { pass: "incremental", phase: "open", from: SINCE, skip: 200, seen: [ACCOUNT], since: SINCE, nextFrom: RECEIVED };

  it("reads back a checkpoint it wrote and nothing else", () => {
    expect(parseDocusignCursor(null)).toBeNull();
    expect(parseDocusignCursor(JSON.stringify({ ...ok, extra: "x" }))).toEqual(ok);
    expect(parseDocusignCursor(JSON.stringify({ ...ok, skip: 1_000_000 }))).toEqual({ ...ok, skip: 1_000_000 });
    for (const phase of ["changed", "open", "done"] as const) expect(parseDocusignCursor(JSON.stringify({ ...ok, phase }))!.phase).toBe(phase);
    const bad: unknown[] = [
      "not json",
      "null",
      "[]",
      "5",
      { ...ok, pass: "other" },
      { ...ok, phase: "later" },
      { ...ok, from: "2026-11-01" },
      { ...ok, from: "2026-02-30T00:00:00.000Z" },
      { ...ok, since: undefined },
      { ...ok, nextFrom: 5 },
      { ...ok, skip: -1 },
      { ...ok, skip: 1.5 },
      { ...ok, skip: "1" },
      { ...ok, skip: 1_000_001 },
      { ...ok, seen: undefined },
      { ...ok, seen: "x" },
      { ...ok, seen: [ACCOUNT.toUpperCase()] },
      { ...ok, seen: [`${ACCOUNT}x`] },
      { ...ok, seen: [5] },
      { ...ok, seen: Array.from({ length: 101 }, () => ACCOUNT) },
    ];
    expect(parseDocusignCursor(JSON.stringify({ ...ok, seen: Array.from({ length: 100 }, () => ACCOUNT) }))!.seen).toHaveLength(100);
    for (const raw of bad) expect(() => parseDocusignCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Docusign checkpoint is not in the expected shape");
  });
});

describe("the Docusign connector", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // Three envelopes changed in the window, one dead-lettered for having no time that reads.
    const result = await checkConnectorSync({ makeConnector: () => connector(account({ pageCap: 1 })).c, expected: { ingested: 2, deadLettered: 1 } });
    expect([result.full.ingested, result.full.deadLettered, result.full.batches]).toEqual([2, 1, 4]);
  });

  it("reads five years of envelopes, oldest status change first, and nothing older", async () => {
    const { c, mock } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(ids(out)).toEqual([E.memo, E.bad, E.consign]);
    expect(out.flatMap((b) => b.events).map((e) => e.payload.kind)).toEqual(["memo", "custom_order", "consignment"]);
    expect(envelopeQueries(mock).map((u) => u.searchParams.get("from_date"))).toEqual([SINCE]);
    expect(envelopeQueries(mock).every((u) => !u.searchParams.has("status"))).toBe(true);
    expect(cursorOf(out)).toEqual({ pass: "historical", phase: "done", from: "2026-11-01T10:00:00.000Z", skip: 0, seen: [], since: SINCE, nextFrom: new Date(NOW.getTime() - DOCUSIGN_OVERLAP_MS).toISOString() });
    // Only reads: the sign-in, the user's accounts and envelope lists.
    expect(new Set(reads(mock))).toEqual(new Set(["POST https://account-d.docusign.com/oauth/token", "GET https://account-d.docusign.com/oauth/userinfo", `GET https://demo.docusign.net/restapi/v2.1/accounts/${ACCOUNT}/envelopes`]));
    expect(JSON.stringify(out)).not.toMatch(/Test Customer|Test Staff|@example|please sign|documents/i);
  });

  it("pages on from the latest status change read, checkpointing it", async () => {
    const day = (i: number) => `2026-10-0${i + 1}T10:00:00.000Z`;
    const many = Array.from({ length: 5 }, (_, i) => envelope(env(`a${i}`), "Memo", "completed", day(i)));
    // Docusign may answer with fewer than the page size asked for; the total says when the pass is done.
    const client: DocusignClient = {
      async envelopes(query) {
        const match = many.filter((e) => Date.parse(e.statusChangedDateTime) >= Date.parse(query.from));
        return { data: match.slice(query.start, query.start + 2), total: match.length };
      },
    };
    const queries: EnvelopeQuery[] = [];
    const spy: DocusignClient = { envelopes: (q) => (queries.push(q), client.envelopes(q)) };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client: spy });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(queries.map((q) => q.from)).toEqual([SINCE, day(1), day(2), day(3)]);
    expect(queries.every((q) => q.start === 0 && q.orderBy === "status_changed" && q.status === undefined)).toBe(true);
    expect(out.map((b, i) => [cursorOf(out, i).phase, cursorOf(out, i).from])).toEqual([
      ["changed", day(1)],
      ["changed", day(2)],
      ["changed", day(3)],
      ["done", day(4)],
    ]);
    expect(new Set(ids(out))).toEqual(new Set(many.map((e) => e.envelopeId)));
  });

  it("asks again from the latest change when a page is full, and pages past a full page that changed at one time", async () => {
    const at = (i: number) => new Date(Date.parse("2026-10-01T10:00:00.000Z") + i * 1000).toISOString();
    // 150 envelopes changed one second apart, then 250 at one instant.
    const rows = [...Array.from({ length: 150 }, (_, i) => envelope(env(`b${i}`), "Memo", "completed", at(i))), ...Array.from({ length: 250 }, (_, i) => envelope(env(`c${i}`), "Memo", "completed", "2026-10-02T10:00:00.000Z"))];
    const queries: EnvelopeQuery[] = [];
    const client: DocusignClient = {
      async envelopes(q) {
        queries.push(q);
        const match = rows.filter((e) => Date.parse(e.statusChangedDateTime) >= Date.parse(q.from));
        return { data: match.slice(q.start, q.start + DOCUSIGN_PAGE_SIZE), total: match.length };
      },
    };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(queries.map((q) => [q.from, q.start])).toEqual([
      [SINCE, 0],
      [at(99), 0],
      ["2026-10-02T10:00:00.000Z", 0],
      ["2026-10-02T10:00:00.000Z", 100],
      ["2026-10-02T10:00:00.000Z", 200],
    ]);
    // Each envelope is sent once: those read at the time the next page asks from aren't sent again.
    expect(ids(out)).toHaveLength(400);
    expect(new Set(ids(out)).size).toBe(400);
    expect(cursorOf(out, 0).seen).toEqual([env("b99")]);
    expect(cursorOf(out, 1).seen).toEqual(Array.from({ length: 49 }, (_, i) => env(`c${i}`)));
    expect(cursorOf(out).seen).toEqual([]);
    expect(out.map((b) => cursorOf(out, out.indexOf(b))).map((x) => [x.phase, x.from, x.skip])).toEqual([
      ["changed", at(99), 0],
      ["changed", "2026-10-02T10:00:00.000Z", 0],
      ["changed", "2026-10-02T10:00:00.000Z", 100],
      ["changed", "2026-10-02T10:00:00.000Z", 200],
      ["done", "2026-10-02T10:00:00.000Z", 0],
    ]);
  });

  it("sends an envelope read at the time it asks from again when it has changed since", async () => {
    const first = Array.from({ length: 100 }, (_, i) => envelope(env(`a${i}`), "Memo", "completed", i === 99 ? "2026-10-02T10:00:00.000Z" : "2026-10-01T10:00:00.000Z"));
    const changedAgain = { ...first[99]!, status: "voided", statusChangedDateTime: ds("2026-10-02T11:00:00.000Z") };
    const pages = [first, [changedAgain, envelope(env("a100"), "Memo", "completed", "2026-10-03T10:00:00.000Z")]];
    const client: DocusignClient = { envelopes: async () => ({ data: pages.shift() ?? [], total: 101 }) };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    // Read already, but at another time now, so it is sent again.
    expect(out[1]!.events.map((e) => e.payload.status)).toEqual(["voided", "completed"]);
    const moved = Array.from({ length: 100 }, (_, i) => envelope(env(`d${i}`), "Memo", "completed", i === 99 ? "2026-10-02T10:00:00.000Z" : "2026-10-01T10:00:00.000Z"));
    const later = { ...moved[0]!, statusChangedDateTime: ds("2026-10-02T10:00:00.000Z"), status: "voided" };
    const pages2 = [moved, [later]];
    const client2: DocusignClient = { envelopes: async () => ({ data: pages2.shift() ?? [], total: 101 }) };
    const c2 = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client: client2 });
    const out2 = await batches(c2.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    // An envelope read earlier at another time that changes to the time asked from is new.
    expect(out2[1]!.events.map((e) => [e.payload.agreementId, e.payload.status])).toEqual([[`docusign:envelope:${env("d0")}`, "voided"]]);
  });

  it("ends the pass when Docusign's total is reached, even on a full page", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => envelope(env(`d${i}`), "Memo", "completed", "2026-10-02T10:00:00.000Z"));
    const queries: EnvelopeQuery[] = [];
    const client: DocusignClient = { envelopes: async (q) => (queries.push(q), { data: rows, total: 100 }) };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client });
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(queries).toHaveLength(1);
  });

  it("moves its checkpoint by status change only, not by other edits, and keeps the latest even out of order", async () => {
    const late = envelope(env("f1"), "Memo", "completed", "2026-10-05T10:00:00.000Z", { lastModifiedDateTime: ds("2026-11-01T10:00:00.000Z") });
    const early = envelope(env("f2"), "Memo", "completed", "2026-10-04T10:00:00.000Z");
    const noChange = { ...envelope(env("f3"), "Memo", "completed", "2026-10-03T10:00:00.000Z"), statusChangedDateTime: undefined, lastModifiedDateTime: ds("2026-12-01T10:00:00.000Z") };
    const full = [late, early, noChange, ...Array.from({ length: 97 }, (_, i) => envelope(env(`g${i}`), "Memo", "completed", "2026-10-01T10:00:00.000Z"))];
    const queries: EnvelopeQuery[] = [];
    const client: DocusignClient = { envelopes: async (q) => (queries.push(q), queries.length === 1 ? { data: full, total: 500 } : { data: [], total: 0 }) };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client });
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(queries[1]!.from).toBe("2026-10-05T10:00:00.000Z");
  });

  it("stops rather than keep a checkpoint it can't read back", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => envelope(env(`h${i}`), "Memo", "completed", "2026-10-02T10:00:00.000Z"));
    const client: DocusignClient = { envelopes: async () => ({ data: rows, total: 5_000_000 }) };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client });
    const saved: DocusignCursor = { pass: "historical", phase: "changed", from: "2026-10-02T10:00:00.000Z", skip: 999_900, seen: [], since: SINCE, nextFrom: RECEIVED };
    const it = c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) })[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    await expect(it.next()).rejects.toThrow("Docusign has more than 1000000 envelopes whose status changed at 2026-10-02T10:00:00.000Z");
  });

  it("resumes an interrupted import from its checkpoint, and a finished one reads nothing", async () => {
    const { c, mock } = connector(account());
    const saved: DocusignCursor = { pass: "historical", phase: "changed", from: "2026-10-20T10:00:00.000Z", skip: 0, seen: [], since: SINCE, nextFrom: RECEIVED };
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(ids(out)).toEqual([E.memo, E.bad, E.consign]);
    expect(cursorOf(out)).toMatchObject({ phase: "done", since: SINCE, nextFrom: RECEIVED });
    const done = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(done).toEqual([]);
    expect(envelopeQueries(mock)).toHaveLength(1);
  });

  it("starts a new import when the checkpoint is an incremental one", async () => {
    const { c } = connector(account());
    const saved: DocusignCursor = { pass: "incremental", phase: "open", from: RECEIVED, skip: 5, seen: [], since: RECEIVED, nextFrom: RECEIVED };
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(ids(out)).toEqual([E.memo, E.bad, E.consign]);
  });

  it("then reads every envelope still out for signature on each incremental pass", async () => {
    const { c, mock } = connector(account());
    const saved: DocusignCursor = { pass: "historical", phase: "done", from: SINCE, skip: 0, seen: [], since: SINCE, nextFrom: "2026-10-25T00:00:00.000Z" };
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    // Changed since the last pass: the consignment. Still out: the custom order and the memo, oldest first.
    expect(ids(out)).toEqual([E.consign, E.bad, E.memo]);
    const [changed, open] = envelopeQueries(mock);
    expect(Object.fromEntries(changed!.searchParams)).toMatchObject({ from_date: "2026-10-25T00:00:00.000Z", order_by: "status_changed" });
    expect(Object.fromEntries(open!.searchParams)).toMatchObject({ from_date: SINCE, status: "sent,delivered", order_by: "created", start_position: "0" });
    expect(cursorOf(out)).toEqual({ pass: "incremental", phase: "done", from: "2026-11-01T10:00:00.000Z", skip: 0, seen: [], since: "2026-10-25T00:00:00.000Z", nextFrom: new Date(NOW.getTime() - DOCUSIGN_OVERLAP_MS).toISOString() });
    expect(cursorOf(out, 0).phase).toBe("open");
  });

  it("pages through the envelopes still out, and resumes from the position reached", async () => {
    const rows = Array.from({ length: 230 }, (_, i) => envelope(env(`i${i}`), "Memo", "sent", "2026-09-01T10:00:00.000Z"));
    const queries: EnvelopeQuery[] = [];
    const client: DocusignClient = {
      async envelopes(q) {
        queries.push(q);
        if (!q.status) return { data: [], total: 0 };
        return { data: rows.slice(q.start, q.start + DOCUSIGN_PAGE_SIZE), total: rows.length };
      },
    };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client });
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(queries.map((q) => [q.status?.join(",") ?? "", q.start])).toEqual([
      ["", 0],
      ["sent,delivered", 0],
      ["sent,delivered", 100],
      ["sent,delivered", 200],
    ]);
    expect(out.map((b, i) => [cursorOf(out, i).phase, cursorOf(out, i).skip])).toEqual([
      ["open", 0],
      ["open", 100],
      ["open", 200],
      ["done", 0],
    ]);
    queries.length = 0;
    await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out[1]!.cursor }));
    expect(queries.map((q) => [q.status?.join(",") ?? "", q.start])).toEqual([
      ["sent,delivered", 100],
      ["sent,delivered", 200],
    ]);
    // An empty page ends the pass even when Docusign's total says there are more.
    const short: DocusignClient = { envelopes: async (q) => (q.status ? { data: rows.slice(q.start, q.start + 50), total: 900 } : { data: [], total: 900 }) };
    const s = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client: short });
    expect((await batches(s.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).map((b) => [parseDocusignCursor(b.cursor)!.phase, parseDocusignCursor(b.cursor)!.skip])).toEqual([
      ["open", 0],
      ["open", 50],
      ["open", 100],
      ["open", 150],
      ["open", 200],
      ["open", 230],
      ["done", 0],
    ]);
  });

  it("stops paging envelopes still out at the checkpoint's limit", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => envelope(env(`j${i}`), "Memo", "sent", "2026-09-01T10:00:00.000Z"));
    const client: DocusignClient = { envelopes: async (q) => (q.status ? { data: rows, total: 5_000_000 } : { data: [], total: 0 }) };
    const c = docusignConnector({ integrationKey: APP, userId: USER, accountId: ACCOUNT, privateKey: PEM, customerKey: KEY, now: () => NOW, client });
    const saved: DocusignCursor = { pass: "incremental", phase: "open", from: RECEIVED, skip: 999_950, seen: [], since: RECEIVED, nextFrom: RECEIVED };
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(out.map((b) => parseDocusignCursor(b.cursor)!.phase)).toEqual(["done"]);
    const atLimit: DocusignCursor = { ...saved, skip: 999_900 };
    const out2 = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(atLimit) }));
    expect(out2.map((b) => [parseDocusignCursor(b.cursor)!.phase, parseDocusignCursor(b.cursor)!.skip])).toEqual([
      ["open", 1_000_000],
      ["done", 0],
    ]);
  });

  it("asks only for envelopes changed since the last pass began, less five minutes, and starts the next from there", async () => {
    const { c, mock } = connector(account());
    const first = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(envelopeQueries(mock)[0]!.searchParams.get("from_date")).toBe(new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
    expect(cursorOf(first).nextFrom).toBe(new Date(NOW.getTime() - DOCUSIGN_OVERLAP_MS).toISOString());
    const { c: c2, mock: m2 } = connector(account(), { now: () => new Date(NOW.getTime() + 3_600_000) });
    await batches(c2.incrementalSync({ organizationId: TEST_ORG, cursor: first.at(-1)!.cursor }));
    expect(envelopeQueries(m2)[0]!.searchParams.get("from_date")).toBe(cursorOf(first).nextFrom);
    expect(DOCUSIGN_OVERLAP_MS).toBe(5 * 60_000);
  });

  it("looks back as long as it is told, and honors a shorter history window", async () => {
    const { c, mock } = connector(account(), { incrementalLookbackHours: 2, historyYears: 1 });
    await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const [changed, open] = envelopeQueries(mock);
    expect(changed!.searchParams.get("from_date")).toBe(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    expect(open!.searchParams.get("from_date")).toBe("2025-11-08T12:00:00.000Z");
    const h = connector(account(), { historyYears: 1 });
    expect(ids(await batches(h.c.historicalImport({ organizationId: TEST_ORG, cursor: null })))).toEqual([E.memo, E.bad, E.consign]);
    expect(envelopeQueries(h.mock)[0]!.searchParams.get("from_date")).toBe("2025-11-08T12:00:00.000Z");
    for (const bad of [0, -1, 1.5]) {
      expect(() => connector(account(), { historyYears: bad }), String(bad)).toThrow("historyYears must be a positive whole number");
      expect(() => connector(account(), { incrementalLookbackHours: bad }), String(bad)).toThrow("incrementalLookbackHours must be a positive whole number");
    }
  });

  it("resumes an interrupted incremental pass in its phase", async () => {
    const { c, mock } = connector(account());
    const saved: DocusignCursor = { pass: "incremental", phase: "changed", from: "2026-10-30T00:00:00.000Z", skip: 0, seen: [], since: "2026-10-29T00:00:00.000Z", nextFrom: "2026-11-07T00:00:00.000Z" };
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(envelopeQueries(mock)[0]!.searchParams.get("from_date")).toBe("2026-10-30T00:00:00.000Z");
    expect(cursorOf(out)).toMatchObject({ phase: "done", since: "2026-10-29T00:00:00.000Z", nextFrom: "2026-11-07T00:00:00.000Z" });
  });

  it("checks the customer reference key before reading anything", () => {
    expect(() => connector(account(), { customerKey: "short" })).toThrow(/CUSTOMER_REF_KEY/);
  });

  it("stops on a sign-in that is turned down, leaving runSync to retry from the checkpoint", async () => {
    const { c } = connector(account({ consented: false }));
    await expect(batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(/hasn't consented/);
    const wrongKey = connector(account({ publicKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey }));
    await expect(batches(wrongKey.c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(/DOCUSIGN_PRIVATE_KEY isn't a key/);
    const wrongUser = connector(account({ userId: guid("f") }));
    await expect(batches(wrongUser.c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(/user_not_found/);
    const wrongApp = connector(account({ integrationKey: guid("f") }));
    await expect(batches(wrongApp.c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(/issuer_not_found/);
  });

  it("waits out Docusign's rate limit and carries on", async () => {
    const waits: number[] = [];
    const { c } = connector(account({ rateLimited: 2, retryAfter: "2" }), { sleep: async (ms: number) => void waits.push(ms) });
    expect(ids(await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null })))).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it("finishes cleanly when the account has no envelopes", async () => {
    const { c } = connector(account({ envelopes: [] }));
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(out.map((b) => [b.events.length, cursorOf(out, out.indexOf(b)).phase])).toEqual([
      [0, "open"],
      [0, "done"],
    ]);
  });

  it("dead-letters an envelope whose times don't read, and stores the rest", async () => {
    const t = testPipeline();
    const { c } = connector(account());
    const report = await runSync({ connector: c, mode: "historical", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    expect([report.ingested, report.deadLettered, report.duplicates]).toEqual([2, 1, 0]);
  });

  it("declares sending an envelope, and turns it down while writes are off", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(DOCUSIGN_WRITES);
    expect(DOCUSIGN_WRITES).toEqual([{ integration: "docusign", name: "send_envelope", description: "Send an agreement for signature, such as a consignment or memo agreement" }]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => [entry.action, entry.outcome])).toEqual([["send_envelope", "refused"]]);
    expect(c.source).toBe("docusign");
    expect(typeof c.handleWebhook).toBe("function");
  });
});
