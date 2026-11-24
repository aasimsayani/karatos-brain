import { createHmac } from "node:crypto";
import { BrainPipeline, InMemoryStore, type Connector, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { describe, expect, it } from "vitest";
import {
  GENERIC_FORM_PROFILE,
  SHOPIFY_LINKED_CUSTOMERS_QUERY,
  SHOPIFY_QUERIES,
  canonicalPhone,
  customerEvents,
  formCustomerRef,
  formCustomerRefs,
  formSubmissionEvent,
  gmailNormalizer,
  gorgiasMessageEvent,
  imapNormalizer,
  klaviyoContactRefs,
  klaviyoProfileEvent,
  metaMessageEvent,
  metaRefs,
  normalizePhone,
  orderEvents,
  outlookNormalizer,
  parseFormProfile,
  phoneRefs,
  quoCustomerRefs,
  quoMessageEvent,
  shopifyConnector,
  shopifyWebhookEvents,
  twilioCustomerRefs,
  twilioNormalizer,
  whatsappMessageEvent,
  zendeskUserEvent,
  type ImapFetched,
  type ImapMessagePlace,
  type ShopifyClient,
  type ShopifyCustomer,
  type ShopifyOrder,
  type TwilioMessage,
} from "../src/index.js";

/**
 * The same customer, recognized across systems by the references each
 * connector makes, never by a name, address or number; then the
 * awaiting-reply rule over the connectors' real output. Every record is
 * synthetic: addresses on example.test, numbers in the 555-01xx range.
 */

// Assembled at runtime so no key-shaped string sits in the repository.
const KEY = "c".repeat(40);
const OTHER_KEY = "d".repeat(40);
const CONTACT_KEY = ["test", "contact", "key", "0".repeat(24)].join("-");
const CORRESPONDENT_KEY = "e".repeat(40);
const ORG = "customer-match-test";
const RECEIVED = "2026-11-18T23:00:00.000Z";
// Wednesday 2026-11-18, 18:00 in New York.
const NOW = "2026-11-18T23:00:00.000Z";
// Wednesday 10:00 in New York.
const OPEN = "2026-11-18T15:00:00.000Z";
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
const rfc2822 = (iso: string) => new Date(iso).toUTCString().replace("GMT", "+0000");
const sid = (prefix: string, n: number) => `${prefix}${"a".repeat(31)}${n}`;

const phoneRef = (e164Digits: string, key = KEY) => formCustomerRef(key, "phone", e164Digits);
const emailRef = (email: string, key = KEY) => formCustomerRef(key, "email", email);

describe("one person's details give the same reference in every system", () => {
  const ANA = "12125550123";
  const expected = phoneRef(ANA);

  it("for a phone number however it is written", () => {
    const written = ["+1 212 555 0123", "+12125550123", "(212) 555-0123", "212-555-0123", "212.555.0123", "1 (212) 555-0123", "001 212 555 0123", "212 555 0123 ext. 4", "(212) 555-0123 x45", "212-555-0123 #9", "+1 212 555 0123 extension 12345"];
    for (const w of written) expect(formCustomerRefs(KEY, { phone: w }), w).toContain(expected);
    expect(quoCustomerRefs(KEY, ["+12125550123"])).toEqual([expected]);
    expect(metaRefs(KEY).phone(ANA)).toEqual([expected]);
    expect(twilioCustomerRefs(KEY, "+12125550123")).toEqual([expected]);
    expect(twilioCustomerRefs(KEY, "whatsapp:+12125550123")).toEqual([expected]);
    expect(klaviyoContactRefs(KEY, { phone: "+12125550123" })).toEqual([expected]);
    expect(klaviyoContactRefs(KEY, { phone: "(212) 555-0123" })).toContain(expected);
    const zendesk = zendeskUserEvent({ id: 41, role: "end-user", phone: "212 555 0123", created_at: "2026-11-01T10:00:00Z" }, { customerKey: KEY, receivedAt: RECEIVED })!;
    expect(zendesk.event.payload.customerRefs).toContain(expected);
    expect(customerEvents(shopifyCustomer({ phone: "+1 (212) 555-0123" }), RECEIVED, KEY)[0]!.payload.contactRefs).toEqual([expected]);
  });

  it("for an email address in any case or spacing", () => {
    const expectedEmail = emailRef("ana@example.test");
    for (const w of ["ana@example.test", " Ana@Example.TEST ", "ANA@EXAMPLE.TEST"]) expect(formCustomerRefs(KEY, { email: w }), w).toEqual([expectedEmail]);
    expect(klaviyoContactRefs(KEY, { email: "Ana@Example.test" })).toEqual([expectedEmail]);
    const gmail = gmailNormalizer({ correspondentKey: CORRESPONDENT_KEY, customerKey: KEY });
    expect(gmail.messageEvents(email("m1", "received", { From: '"Ana Synthetic" <Ana@Example.test>' }), RECEIVED)[0]!.payload.customerRefs).toEqual([expectedEmail]);
    expect(customerEvents(shopifyCustomer({ email: "ANA@example.test" }), RECEIVED, KEY)[0]!.payload.contactRefs).toEqual([expectedEmail]);
  });

  it("and different people, kinds and instances never share one", () => {
    expect(phoneRef("12125550123")).not.toBe(phoneRef("12125550124"));
    expect(emailRef("ana@example.test")).not.toBe(emailRef("ana2@example.test"));
    expect(formCustomerRef(KEY, "phone", "12125550123")).not.toBe(formCustomerRef(KEY, "email", "12125550123"));
    expect(phoneRef("12125550123", OTHER_KEY)).not.toBe(phoneRef("12125550123"));
    // A ten-digit number written with + is not read as North American, so it never takes a +1 number's reference.
    expect(formCustomerRefs(KEY, { phone: "+2125550123" })).toEqual([phoneRef("2125550123")]);
    expect(new Set([...formCustomerRefs(KEY, { phone: "(212) 555-0123" }), ...formCustomerRefs(KEY, { phone: "(212) 555-0124" })]).size).toBe(4);
  });

  it("keeps every reference earlier records have: the digits-only one comes first, unchanged", () => {
    const legacy = `form_customer:${createHmac("sha256", KEY).update("phone:2125550123", "utf8").digest("hex").slice(0, 32)}`;
    expect(formCustomerRefs(KEY, { phone: "(212) 555-0123" })).toEqual([legacy, phoneRef("12125550123")]);
    expect(formCustomerRefs(KEY, { email: "ana@example.test", phone: "(212) 555-0123" })).toEqual([emailRef("ana@example.test"), legacy, phoneRef("12125550123")]);
    expect(phoneRefs(KEY, "+12125550123")).toEqual([phoneRef("12125550123")]);
    expect(phoneRefs(KEY, "not a number")).toEqual([]);
    // Too many digits once the extension is in, so only the number without it has a reference.
    expect(normalizePhone("+1 212 555 0123 ext 12345")).toBeUndefined();
    expect(phoneRefs(KEY, "+1 212 555 0123 ext 12345")).toEqual([phoneRef("12125550123")]);
    expect(klaviyoContactRefs(KEY, { phone: "(212) 555-0123" })).toEqual([legacy, phoneRef("12125550123")]);
    expect(klaviyoContactRefs(KEY, { phone: 2125550123 })).toEqual([]);
  });
});

describe("canonicalPhone", () => {
  it("gives E.164 digits", () => {
    const cases: [unknown, string | undefined][] = [
      ["+1 212 555 0123", "12125550123"],
      ["(212) 555-0123", "12125550123"],
      [2125550123, "12125550123"],
      ["  212 555 0123  ", "12125550123"],
      ["  +2125550123", "2125550123"],
      ["0044 212 555 0123", "442125550123"],
      ["00 1 212 555 0123", "12125550123"],
      // 00 then 0 is no country code.
      ["0002125550123", "0002125550123"],
      ["+44 212 555 0123", "442125550123"],
      // Not North American: an area code starting 0 or 1.
      ["(112) 555-0123", "1125550123"],
      ["021 555 0123", "0215550123"],
      ["212 555 0123 ext. 4", "12125550123"],
      ["212 555 0123 EXT 4", "12125550123"],
      ["212 555 0123 extension 4", "12125550123"],
      ["212 555 0123x4", "12125550123"],
      ["212 555 0123 # 4", "12125550123"],
      ["(212) 555-0123 x123456", "12125550123"],
      // An extension is only at the end, and of one to six digits.
      ["212 555 0123 x1234567", undefined],
      ["x4 212 555 0123", "42125550123"],
      ["555 0123", "5550123"],
      ["555 012", undefined],
      ["1".repeat(15), "1".repeat(15)],
      ["1".repeat(16), undefined],
      ["+".repeat(65), undefined],
      ["2125550123".padStart(64, " "), "12125550123"],
      ["2125550123".padStart(65, " "), undefined],
      [`${"0".repeat(54)}2125550123`, undefined],
      ["", undefined],
      [null, undefined],
      [{ phone: "2125550123" }, undefined],
    ];
    for (const [input, out] of cases) expect(canonicalPhone(input), String(input)).toBe(out);
  });
});

describe("connectors that now carry customer references", () => {
  it("Twilio adds the number's customer references beside its contact reference, only with CUSTOMER_REF_KEY", () => {
    const inbound = twilioMessage(1, "inbound", "+12125550123");
    const plain = twilioNormalizer(CONTACT_KEY).message(inbound, RECEIVED)[0]!;
    expect(plain.payload).not.toHaveProperty("customerRefs");
    const linked = twilioNormalizer(CONTACT_KEY, KEY).message(inbound, RECEIVED)[0]!;
    expect(linked.payload.customerRefs).toEqual([phoneRef("12125550123")]);
    expect(linked.payload.contactRef).toBe(plain.payload.contactRef);
    expect(linked.idempotencyKey).toBe(plain.idempotencyKey);
    const out = twilioNormalizer(CONTACT_KEY, KEY).message(twilioMessage(2, "outbound-api", "+12125550124"), RECEIVED)[0]!;
    expect(out.payload.customerRefs).toEqual([phoneRef("12125550124")]);
    const call = twilioNormalizer(CONTACT_KEY, KEY).call({ sid: sid("CA", 1), direction: "inbound", status: "completed", from: "+12125550125", to: "+12125550100", duration: "30", price: null, price_unit: null, start_time: rfc2822(OPEN), end_time: rfc2822(OPEN), date_created: rfc2822(OPEN) }, RECEIVED)[0]!;
    expect(call.payload.customerRefs).toEqual([phoneRef("12125550125")]);
    expect(twilioCustomerRefs(KEY, "client:front-desk")).toEqual([]);
    // Twilio writes E.164; digits without a + are taken as written, never given a country code.
    expect(twilioCustomerRefs(KEY, "2125550123")).toEqual([phoneRef("2125550123")]);
    expect(twilioCustomerRefs(KEY, null)).toEqual([]);
    expect(() => twilioNormalizer(CONTACT_KEY, "short")).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("Gmail adds the other side's customer references, only with CUSTOMER_REF_KEY", () => {
    const sent = email("m2", "sent", { From: "store@example.test", To: "Ana <ana@example.test>, ben@example.test", Cc: "Ana@example.test, cara@example.test" });
    const plain = gmailNormalizer({ correspondentKey: CORRESPONDENT_KEY }).messageEvents(sent, RECEIVED)[0]!;
    expect(plain.payload).not.toHaveProperty("customerRefs");
    const gmail = gmailNormalizer({ correspondentKey: CORRESPONDENT_KEY, customerKey: KEY });
    const linked = gmail.messageEvents(sent, RECEIVED)[0]!;
    expect(linked.payload.customerRefs).toEqual([emailRef("ana@example.test"), emailRef("ben@example.test"), emailRef("cara@example.test")].sort());
    expect(linked.idempotencyKey).toBe(plain.idempotencyKey);
    expect(linked.payload.from).toEqual(plain.payload.from);
    // A received message is from one person: whoever else it went to isn't the customer.
    const received = gmail.messageEvents(email("m3", "received", { From: "Ana <ana@example.test>, other@example.test", To: "store@example.test" }), RECEIVED)[0]!;
    expect(received.payload.customerRefs).toEqual([emailRef("ana@example.test")]);
    expect(gmail.messageEvents(email("m4", "received", { To: "store@example.test" }), RECEIVED)[0]!.payload.customerRefs).toEqual([]);
    expect(() => gmailNormalizer({ correspondentKey: CORRESPONDENT_KEY, customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("Shopify hashes a customer's email and phone into contact references only when linking is on", () => {
    const customer = shopifyCustomer({ email: "ana@example.test", phone: "+12125550123" });
    const plain = customerEvents(customer, RECEIVED)[0]!;
    expect(plain.payload).toEqual({ customerId: "shopify:customer:7001", name: "Synthetic customer", marketingConsent: false });
    expect(plain.idempotencyKey).toBe("shopify:customer:7001:2026-11-01T12:00:00Z");
    const linked = customerEvents(customer, RECEIVED, KEY)[0]!;
    expect(linked.payload.contactRefs).toEqual([emailRef("ana@example.test"), phoneRef("12125550123")]);
    expect(linked.idempotencyKey).toBe("shopify:customer:7001:2026-11-01T12:00:00Z:linked");
    expect(customerEvents(shopifyCustomer({}), RECEIVED, KEY)[0]!.payload.contactRefs).toEqual([]);
    const flat = JSON.stringify(linked);
    for (const leaked of ["ana@example.test", "2125550123", "5550123"]) expect(flat).not.toContain(leaked);
    // Webhooks carry the REST shape.
    const hook = shopifyWebhookEvents({ topic: "customers/update", payload: { id: 7001, first_name: "Synthetic", updated_at: "2026-11-01T12:00:00Z", email: "ana@example.test", phone: "+12125550123" } }, RECEIVED, KEY)[0]!;
    expect(hook.payload.contactRefs).toEqual(linked.payload.contactRefs);
    expect(shopifyWebhookEvents({ topic: "customers/update", payload: { id: 7001, updated_at: "2026-11-01T12:00:00Z", email: 5, phone: null } }, RECEIVED, KEY)[0]!.payload.contactRefs).toEqual([]);
    expect(shopifyWebhookEvents({ topic: "customers/update", payload: { id: 7001, updated_at: "2026-11-01T12:00:00Z", email: "ana@example.test" } }, RECEIVED)[0]!.payload).not.toHaveProperty("contactRefs");
  });

  it("Shopify asks for the email and phone only when linking is on, and reads every customer again once", async () => {
    expect(SHOPIFY_LINKED_CUSTOMERS_QUERY).toContain("defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }");
    expect(SHOPIFY_QUERIES.customers.query).not.toContain("defaultEmailAddress");
    expect(SHOPIFY_LINKED_CUSTOMERS_QUERY.replace(" defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }", "")).toBe(SHOPIFY_QUERIES.customers.query);
    const run = async (connector: Connector, mode: "historicalImport" | "incrementalSync", cursor: string | null) => {
      const batches: SourceBatch[] = [];
      for await (const b of connector[mode]({ organizationId: ORG, cursor }) as AsyncIterable<SourceBatch>) batches.push(b);
      return batches;
    };
    const asked: { query: string; since: string }[] = [];
    const client: ShopifyClient = {
      query: async <T,>(query: string, variables: Record<string, unknown>) => {
        asked.push({ query, since: String(variables.query) });
        const stream = query.includes("customers(") ? "customers" : query.includes("orders(") ? "orders" : "products";
        const nodes = stream === "customers" ? [{ ...shopifyCustomer({ email: "ana@example.test" }) }] : [];
        return { [stream]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } as T;
      },
    } as unknown as ShopifyClient;
    const now = () => new Date(NOW);
    const before = { stream: "done", after: null, since: { orders: "2026-11-01T00:00:00Z", products: "2026-11-01T00:00:00Z", customers: "2026-11-01T00:00:00Z" }, latest: { customers: "2026-11-17T00:00:00Z" } };

    // Off: the old query, from where the last pass got to.
    const off = await run(shopifyConnector({ shopDomain: "demo.myshopify.com", accessToken: "t", client, now }), "incrementalSync", JSON.stringify(before));
    const offCustomers = asked.filter((a) => a.query.includes("customers("));
    expect(offCustomers.map((a) => [a.query === SHOPIFY_QUERIES.customers.query, a.since])).toEqual([[true, "updated_at:>='2026-11-17T00:00:00Z'"]]);
    expect(JSON.parse(off.at(-1)!.cursor!)).not.toHaveProperty("customersLinked");

    // On: the first pass reads every customer again; the next starts where it got to.
    asked.length = 0;
    const linked = shopifyConnector({ shopDomain: "demo.myshopify.com", accessToken: "t", client, now, customerKey: KEY });
    const first = await run(linked, "incrementalSync", JSON.stringify(before));
    expect(asked.filter((a) => a.query.includes("customers(")).map((a) => [a.query === SHOPIFY_LINKED_CUSTOMERS_QUERY, a.since])).toEqual([[true, "updated_at:>='2021-11-18T23:00:00.000Z'"]]);
    expect(asked.filter((a) => a.query.includes("orders(")).map((a) => a.since)).toEqual(["updated_at:>='2026-11-01T00:00:00Z'"]);
    const cursor = first.at(-1)!.cursor!;
    expect(JSON.parse(cursor)).toMatchObject({ stream: "done", customersLinked: true });
    expect(first.flatMap((b) => b.events).map((e) => (e as { payload: Record<string, unknown> }).payload.contactRefs)).toEqual([[emailRef("ana@example.test")]]);
    asked.length = 0;
    await run(linked, "incrementalSync", cursor);
    expect(asked.filter((a) => a.query.includes("customers(")).map((a) => a.since)).toEqual(["updated_at:>='2026-11-17T00:00:00Z'"]);
    // A first import with linking on marks its cursor too; with none there is nothing to read again.
    asked.length = 0;
    const fresh = await run(linked, "historicalImport", null);
    expect(JSON.parse(fresh.at(-1)!.cursor!)).toMatchObject({ customersLinked: true });
    asked.length = 0;
    await run(linked, "incrementalSync", null);
    expect(asked.filter((a) => a.query.includes("customers(")).map((a) => a.since)).toEqual(["updated_at:>='2026-11-16T23:00:00.000Z'"]);
    const hook = await linked.handleWebhook!({ topic: "customers/update", payload: { id: 7001, updated_at: "2026-11-01T12:00:00Z", email: "ana@example.test" } });
    expect((hook as Raw[])[0]!.payload.contactRefs).toEqual([emailRef("ana@example.test")]);
    expect(() => shopifyConnector({ shopDomain: "demo.myshopify.com", accessToken: "t", client, customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });
});

describe("IMAP and Outlook mail carry the same customer references as Gmail", () => {
  const STORE = "store@example.test";
  const INBOX: ImapMessagePlace = { role: "inbox", mailbox: "INBOX", uidValidity: "7" };
  const SENT: ImapMessagePlace = { role: "sent", mailbox: "Sent", uidValidity: "9" };
  const imap = imapNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, ownAddress: STORE });
  const outlook = outlookNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, mailbox: STORE });
  const gmail = gmailNormalizer({ correspondentKey: CORRESPONDENT_KEY, customerKey: KEY });
  const imapRefs = (place: ImapMessagePlace, headers: Record<string, string>, n = imapAddressBook.next++) => imap.message(place, imapMessage(n, headers), RECEIVED)[0]!.payload.customerRefs;
  const outlookRefs = (folder: "inbox" | "sentitems", fields: Record<string, unknown>) => outlook.message(folder, outlookMessage(folder, fields), RECEIVED)[0]!.payload.customerRefs;

  it("gives an address the reference Gmail, Klaviyo and a form give it, in any case, and a plus-address its own", () => {
    for (const [i, written] of ["ana@example.test", "Ana@Example.TEST", "ANA@EXAMPLE.TEST"].entries()) {
      const expected = formCustomerRefs(KEY, { email: written });
      expect(expected).toEqual([emailRef("ana@example.test")]);
      expect(imapRefs(INBOX, { From: `"Ana Synthetic" <${written}>`, To: STORE }), written).toEqual(expected);
      expect(outlookRefs("inbox", { from: person(written) }), written).toEqual(expected);
      expect(gmail.messageEvents(email(`g${i}`, "received", { From: written }), RECEIVED)[0]!.payload.customerRefs).toEqual(expected);
      expect(klaviyoContactRefs(KEY, { email: written })).toEqual(expected);
    }
    // Forms keep a plus-address as it was typed, so every mailbox does too: it is a reference of its own.
    const plus = formCustomerRefs(KEY, { email: "ana+rings@example.test" });
    expect(plus).not.toEqual([emailRef("ana@example.test")]);
    expect(imapRefs(INBOX, { From: "Ana+Rings@example.test" })).toEqual(plus);
    expect(outlookRefs("inbox", { from: person("Ana+Rings@example.test") })).toEqual(plus);
    expect(gmail.messageEvents(email("gplus", "received", { From: "Ana+Rings@example.test" }), RECEIVED)[0]!.payload.customerRefs).toEqual(plus);
    expect(klaviyoContactRefs(KEY, { email: "Ana+Rings@example.test" })).toEqual(plus);
    // Other instances' keys give other references.
    const other = imapNormalizer(CORRESPONDENT_KEY, { customerKey: OTHER_KEY }).message(INBOX, imapMessage(90, { From: "ana@example.test" }), RECEIVED)[0]!.payload.customerRefs;
    expect(other).toEqual([emailRef("ana@example.test", OTHER_KEY)]);
  });

  it("takes the other side by Gmail's rule: who wrote a received message, who a sent one went to, never the store", () => {
    const received = { From: "Ana <ana@example.test>, other@example.test", To: `${STORE}, ben@example.test`, Cc: "cara@example.test" };
    const sent = { From: `Store <${STORE}>`, To: "Ana <ana@example.test>, ben@example.test", Cc: `Ana@example.test, cara@example.test, ${STORE.toUpperCase()}` };
    const customers = [emailRef("ana@example.test"), emailRef("ben@example.test"), emailRef("cara@example.test")].sort();
    expect(imapRefs(INBOX, received)).toEqual([emailRef("ana@example.test")]);
    expect(imapRefs(SENT, sent)).toEqual(customers);
    const graph = (h: Record<string, string>) => ({
      from: person(h.From!.split(",")[0]!.replace(/.*</, "").replace(">", "")),
      toRecipients: h.To!.split(",").map((a) => person(a.replace(/.*</, "").replace(">", ""))),
      ccRecipients: h.Cc!.split(",").map((a) => person(a)),
    });
    expect(outlookRefs("inbox", graph(received))).toEqual([emailRef("ana@example.test")]);
    expect(outlookRefs("sentitems", graph(sent))).toEqual(customers);
    // Gmail gives the same for the same message, except that it doesn't know which address is the store's.
    expect(gmail.messageEvents(email("gin", "received", received), RECEIVED)[0]!.payload.customerRefs).toEqual([emailRef("ana@example.test")]);
    expect(gmail.messageEvents(email("gout", "sent", sent), RECEIVED)[0]!.payload.customerRefs).toEqual([...customers, emailRef(STORE)].sort());
    // The mailbox writing to itself, or a message from it in the inbox, is nobody waiting.
    expect(imapRefs(INBOX, { From: `Store <${STORE}>`, To: "ana@example.test" })).toEqual([]);
    expect(imapRefs(SENT, { From: STORE, To: ` ${STORE.toUpperCase()} ` })).toEqual([]);
    expect(outlookRefs("inbox", { from: person(STORE), toRecipients: [person("ana@example.test")] })).toEqual([]);
    expect(outlookRefs("sentitems", { toRecipients: [person("Store@Example.test")] })).toEqual([]);
    // The mailbox's own address is read the way an address is, in any case or spacing.
    const spaced = imapNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, ownAddress: " Store@Example.TEST " });
    expect(spaced.message(SENT, imapMessage(94, { To: `${STORE}, ana@example.test` }), RECEIVED)[0]!.payload.customerRefs).toEqual([emailRef("ana@example.test")]);
    const spacedGraph = outlookNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, mailbox: " Store@Example.TEST " });
    expect(spacedGraph.message("sentitems", outlookMessage("sentitems", { toRecipients: [person(STORE), person("ana@example.test")] }), RECEIVED)[0]!.payload.customerRefs).toEqual([emailRef("ana@example.test")]);
    // A message with nobody on the other side has none, as Gmail's has.
    expect(imapRefs(INBOX, { To: STORE })).toEqual([]);
    expect(outlookRefs("inbox", { toRecipients: [person(STORE)] })).toEqual([]);
    expect(outlookRefs("inbox", { from: person("not an address") })).toEqual([]);
    // An own address that isn't one (an IMAP sign-in name, an Outlook object id) excludes nobody.
    const byName = imapNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, ownAddress: "store-login" });
    expect(byName.message(SENT, imapMessage(91, { To: STORE }), RECEIVED)[0]!.payload.customerRefs).toEqual([emailRef(STORE)]);
    const byId = outlookNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, mailbox: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    expect(byId.message("sentitems", outlookMessage("sentitems", { toRecipients: [person(STORE)] }), RECEIVED)[0]!.payload.customerRefs).toEqual([emailRef(STORE)]);
  });

  it("keeps fifty people a side, as the correspondents are, and never a raw address", () => {
    const many = Array.from({ length: 60 }, (_, i) => `c${i}@example.test`);
    const refs = imapRefs(SENT, { To: many.join(", ") }) as string[];
    expect(refs).toEqual(many.slice(0, 50).map((a) => emailRef(a)).sort());
    const viaGraph = outlookRefs("sentitems", { toRecipients: many.map(person) }) as string[];
    expect(viaGraph).toEqual(refs);
    const flat = JSON.stringify([imap.message(SENT, imapMessage(92, { To: "Ana <ana@example.test>" }), RECEIVED), outlook.message("sentitems", outlookMessage("sentitems", { toRecipients: [person("ana@example.test")] }), RECEIVED)]);
    // A business domain is kept beside the correspondent, as Gmail keeps it; the address itself never is.
    for (const leaked of ["ana@", "ana", "Ana"]) expect(flat, leaked).not.toContain(leaked);
  });

  it("adds none without CUSTOMER_REF_KEY, and changes nothing else when it does", () => {
    const fetched = imapMessage(93, { From: "ana@example.test", To: STORE });
    const plainImap = imapNormalizer(CORRESPONDENT_KEY).message(INBOX, fetched, RECEIVED)[0]!;
    expect(plainImap.payload).not.toHaveProperty("customerRefs");
    expect(imapNormalizer(CORRESPONDENT_KEY, { ownAddress: STORE }).message(INBOX, fetched, RECEIVED)[0]).toEqual(plainImap);
    const linkedImap = imap.message(INBOX, fetched, RECEIVED)[0]!;
    expect(linkedImap.idempotencyKey).toBe(plainImap.idempotencyKey);
    expect({ ...linkedImap.payload, customerRefs: undefined }).toEqual({ ...plainImap.payload, customerRefs: undefined });

    const raw = outlookMessage("inbox", { from: person("ana@example.test") });
    const plainOutlook = outlookNormalizer(CORRESPONDENT_KEY).message("inbox", raw, RECEIVED)[0]!;
    expect(plainOutlook.payload).not.toHaveProperty("customerRefs");
    expect(outlookNormalizer(CORRESPONDENT_KEY, { mailbox: STORE }).message("inbox", raw, RECEIVED)[0]).toEqual(plainOutlook);
    const linkedOutlook = outlook.message("inbox", raw, RECEIVED)[0]!;
    expect({ ...linkedOutlook.payload, customerRefs: undefined }).toEqual({ ...plainOutlook.payload, customerRefs: undefined });
    // Outlook keys a message by its payload, so the linked one is a new version of it, stored beside the old.
    expect(linkedOutlook.idempotencyKey).not.toBe(plainOutlook.idempotencyKey);
    // Calendar invitations carry none: nobody waits on one.
    expect(outlook.appointment({ id: "ev1", lastModifiedDateTime: OPEN, organizer: person("ana@example.test") }, RECEIVED).payload).not.toHaveProperty("customerRefs");
    // A key too short to be a secret is turned down, as everywhere else.
    expect(() => imapNormalizer(CORRESPONDENT_KEY, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
    expect(() => outlookNormalizer(CORRESPONDENT_KEY, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });
});

describe("customers waiting on a reply, from the connectors' own records", () => {
  it("links a customer's orders, texts, DMs and email across systems, and raises only the one still waiting", async () => {
    const b = brain();
    const quoCtx = { customerKey: KEY, receivedAt: RECEIVED };
    const refs = metaRefs(KEY);
    const wa = { phoneNumberId: "store-line-1", refs, receivedAt: RECEIVED };
    const gmail = gmailNormalizer({ correspondentKey: CORRESPONDENT_KEY, customerKey: KEY });
    const twilio = twilioNormalizer(CONTACT_KEY, KEY);

    // Ana: two Shopify orders worth $5,200, a text on Quo and a WhatsApp message, and no answer anywhere.
    await b.send("shopify", customerEvents(shopifyCustomer({ email: "ana@example.test", phone: "(212) 555-0123" }), RECEIVED, KEY));
    await b.send("shopify", orderEvents(shopifyOrder(1, 7001, "3200.00"), RECEIVED));
    await b.send("shopify", orderEvents(shopifyOrder(2, 7001, "2000.00"), RECEIVED));
    const anaText = quoMessageEvent(quoMessage("ACana1", "+12125550123", OPEN), quoCtx).event;
    await b.send("openphone", [anaText]);
    const anaWa = whatsappMessageEvent({ id: "wamid.ana1", from: "12125550123", timestamp: String(Date.parse(at(OPEN, 90)) / 1000), type: "text", text: { body: "Hello?" } }, wa).event;
    await b.send("meta", [anaWa]);
    // A newsletter to the store's inbox from an address nothing else knows is no customer.
    await b.send("gmail", gmail.messageEvents(email("news1", "received", { From: "news@example.test", To: "store@example.test" }, OPEN), RECEIVED));

    // Ben: Klaviyo knows his email and number; he wrote on WhatsApp and the store answered by email.
    await b.send("klaviyo", [klaviyoProfileEvent({ type: "profile", id: "01JTESTPROFILE000000000002", attributes: { email: "ben@example.test", phone_number: "+12125550124", updated: "2026-11-01T12:00:00+00:00" } }, { customerKey: KEY, receivedAt: RECEIVED })!]);
    await b.send("meta", [whatsappMessageEvent({ id: "wamid.ben1", from: "12125550124", timestamp: String(Date.parse(OPEN) / 1000), type: "text", text: { body: "Ring size?" } }, wa).event]);
    await b.send("gmail", gmail.messageEvents(email("ben2", "sent", { From: "store@example.test", To: "Ben <ben@example.test>" }, at(OPEN, 45)), RECEIVED));

    // Cara: texted Twilio; Zendesk has her number as she typed it, without the country code, beside her email, and the store answered from Gorgias by email.
    await b.send("twilio", twilio.message(twilioMessage(3, "inbound", "+12125550125", OPEN), RECEIVED));
    await b.send("zendesk", [zendeskUserEvent({ id: 43, role: "end-user", email: "cara@example.test", phone: "212-555-0125", created_at: "2026-11-01T10:00:00Z" }, { customerKey: KEY, receivedAt: RECEIVED })!.event]);
    await b.send("gorgias", [
      gorgiasMessageEvent(
        { id: 9001, ticket_id: 77, created_datetime: at(OPEN, 30).replace(".000Z", ""), sent_datetime: at(OPEN, 30).replace(".000Z", ""), public: true, from_agent: true, channel: "email", via: "email", source: { to: [{ address: "cara@example.test" }] } },
        { customerKey: KEY, receivedAt: RECEIVED },
      ).event,
    ]);

    // Dev: an Instagram DM. Instagram gives no email or number, so it can't link, and Dev has bought nothing.
    await b.send("meta", [
      metaMessageEvent(
        { id: "m_dev1", created_time: at(OPEN, 60).replace(".000Z", "+0000"), from: { id: "ig-dev-1" }, to: { data: [{ id: "ig-store-1" }] }, message: "Do you resize?" },
        { channel: "instagram", businessId: "ig-store-1", refs, conversationRef: refs.node("instagram", "conversation", "c1"), receivedAt: RECEIVED },
      ).event,
    ]);

    const recs = (await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"));
    expect(recs.map((r) => r.id)).toEqual([`rec_clienteling_awaiting_reply_${anaText.payload.messageId}_2026-11-18`, "rec_clienteling_awaiting_reply_others_2026-11-18"]);
    const [ana, others] = recs;
    expect(ana!.summary).toBe(
      "A high-value customer, who has spent $5,200.00 over 2 orders, has waited 8 business hours for a reply. They wrote 2 messages on Quo and WhatsApp, the first at 2026-11-18 15:00 UTC, and nobody has answered on any channel since. Reply on WhatsApp, where they wrote last.",
    );
    // It cites the messages and the sales, by the connectors' own event ids.
    expect(ana!.provenance.eventIds).toEqual(expect.arrayContaining([anaText.id, anaWa.id, "shopify_sale:1", "shopify_sale:2"]));
    expect(ana!.provenance.eventIds).toHaveLength(4);
    expect(others!.summary).toBe(
      "1 customer has waited 4 or more business hours for a reply, with no answer on any channel: 1 on Instagram. The longest has waited 7 business hours. Answer them from each inbox, oldest first.",
    );

    // Nothing kept names anyone.
    const flat = JSON.stringify([await b.memory.recentSignals(ORG, 1000), recs]);
    for (const leaked of ["example.test", "2125550123", "555-0123", "5550124", "5550125", "Hello?", "Ring size", "Do you resize"]) expect(flat, leaked).not.toContain(leaked);
  });

  it("stops raising a customer once anyone answers on any of their channels, and replays change nothing", async () => {
    const b = brain();
    const quoCtx = { customerKey: KEY, receivedAt: RECEIVED };
    await b.send("shopify", customerEvents(shopifyCustomer({ email: "ana@example.test", phone: "(212) 555-0123" }), RECEIVED, KEY));
    await b.send("shopify", orderEvents(shopifyOrder(1, 7001, "300.00"), RECEIVED));
    const text = quoMessageEvent(quoMessage("ACana1", "+12125550123", OPEN), quoCtx).event;
    await b.send("openphone", [text, text]);
    await b.send("shopify", orderEvents(shopifyOrder(1, 7001, "300.00"), RECEIVED));
    const first = (await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"));
    expect(first).toHaveLength(1);
    expect(first[0]!.summary).toContain("A past customer, who has spent $300.00 over 1 order,");
    expect(first[0]!.summary).toContain("They wrote 1 message on Quo");

    // The store calls back from Twilio, which knows her by number.
    const twilio = twilioNormalizer(CONTACT_KEY, KEY);
    await b.send("twilio", twilio.call({ sid: sid("CA", 2), direction: "outbound-api", status: "completed", from: "+12125550100", to: "+12125550123", duration: "120", price: null, price_unit: null, start_time: rfc2822(at(OPEN, 400)), end_time: rfc2822(at(OPEN, 402)), date_created: rfc2822(at(OPEN, 400)) }, RECEIVED));
    expect((await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"))).toEqual([]);
  });

  it("counts a reply from an Outlook or IMAP mailbox as an answer to a WhatsApp message or a text", async () => {
    const b = brain();
    const wa = { phoneNumberId: "store-line-1", refs: metaRefs(KEY), receivedAt: RECEIVED };
    const outlook = outlookNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, mailbox: "store@example.test" });
    const imap = imapNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, ownAddress: "store@example.test" });
    const form = (n: number, mail: string, phone: string) =>
      formSubmissionEvent({ provider: "webhook", formId: "contact", responseId: `sub${n}`, submittedAt: at(OPEN, -60), answers: [{ names: ["email"], kind: "email", values: [mail] }, { names: ["phone"], kind: "phone", values: [phone] }] }, parseFormProfile(GENERIC_FORM_PROFILE), KEY, RECEIVED)!;

    // Ben filled in the website's form with his email and number, then wrote on WhatsApp.
    await b.send("forms", [form(1, "Ben@example.test", "(212) 555-0124")]);
    const benWa = whatsappMessageEvent({ id: "wamid.ben1", from: "12125550124", timestamp: String(Date.parse(OPEN) / 1000), type: "text", text: { body: "Ring size?" } }, wa).event;
    await b.send("meta", [benWa]);
    // Cara: Klaviyo knows her email and number; she texted on Twilio.
    await b.send("klaviyo", [klaviyoProfileEvent({ type: "profile", id: "01JTESTPROFILE000000000003", attributes: { email: "cara@example.test", phone_number: "+12125550125", updated: "2026-11-01T12:00:00+00:00" } }, { customerKey: KEY, receivedAt: RECEIVED })!]);
    await b.send("twilio", twilioNormalizer(CONTACT_KEY, KEY).message(twilioMessage(5, "inbound", "+12125550125", OPEN), RECEIVED));

    const waiting = (await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"));
    expect(waiting.map((r) => r.id)).toEqual(["rec_clienteling_awaiting_reply_others_2026-11-18"]);
    expect(waiting[0]!.summary).toContain("2 customers have waited");

    // The store answers Ben from Outlook's Sent Items, and Cara from the IMAP mailbox's Sent folder, by email.
    await b.send("microsoft_outlook", outlook.message("sentitems", outlookMessage("sentitems", { sentDateTime: at(OPEN, 30), from: person("store@example.test"), toRecipients: [person("BEN@example.test")] }), RECEIVED));
    const afterBen = (await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"));
    expect(afterBen.map((r) => r.summary)).toEqual([expect.stringContaining("1 customer has waited")]);
    expect(afterBen[0]!.summary).toContain("1 on sms");
    await b.send("imap_email", imap.message({ role: "sent", mailbox: "Sent", uidValidity: "9" }, imapMessage(7, { From: "store@example.test", To: "Cara <cara@example.test>" }, at(OPEN, 45)), RECEIVED));
    expect((await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"))).toEqual([]);

    // Nothing kept names anyone.
    const flat = JSON.stringify(await b.memory.recentSignals(ORG, 1000));
    for (const leaked of ["example.test", "5550124", "5550125", "Ring size"]) expect(flat, leaked).not.toContain(leaked);
  });

  it("raises a past buyer who wrote to an IMAP or Outlook inbox, and an email nobody else knows stays unraised", async () => {
    const b = brain();
    const outlook = outlookNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, mailbox: "store@example.test" });
    const imap = imapNormalizer(CORRESPONDENT_KEY, { customerKey: KEY, ownAddress: "store@example.test" });
    await b.send("shopify", customerEvents(shopifyCustomer({ email: "ana@example.test" }), RECEIVED, KEY));
    await b.send("shopify", orderEvents(shopifyOrder(1, 7001, "300.00"), RECEIVED));
    const anaMail = outlook.message("inbox", outlookMessage("inbox", { receivedDateTime: OPEN, from: person("Ana@Example.test"), toRecipients: [person("store@example.test")] }), RECEIVED);
    await b.send("microsoft_outlook", anaMail);
    // A newsletter to the IMAP inbox, and the store's own mail to itself, are nobody waiting.
    await b.send("imap_email", imap.message({ role: "inbox", mailbox: "INBOX", uidValidity: "7" }, imapMessage(8, { From: "news@example.test", To: "store@example.test" }, OPEN), RECEIVED));
    await b.send("imap_email", imap.message({ role: "inbox", mailbox: "INBOX", uidValidity: "7" }, imapMessage(9, { From: "store@example.test", To: "store@example.test" }, OPEN), RECEIVED));
    const recs = (await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"));
    expect(recs.map((r) => r.id)).toEqual([`rec_clienteling_awaiting_reply_${anaMail[0]!.payload.messageId}_2026-11-18`]);
    expect(recs[0]!.summary).toContain("A past customer, who has spent $300.00 over 1 order,");
    expect(recs[0]!.summary).toContain("They wrote 1 message on Outlook");
    expect(recs[0]!.provenance.eventIds).toEqual(expect.arrayContaining([anaMail[0]!.id, "shopify_sale:1"]));
    // Answered from the other mailbox, she is no longer waiting.
    await b.send("imap_email", imap.message({ role: "sent", mailbox: "Sent", uidValidity: "9" }, imapMessage(10, { From: "store@example.test", To: "ana@example.test" }, at(OPEN, 300)), RECEIVED));
    expect((await b.reason()).filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_"))).toEqual([]);
  });
});

type Raw = { id: string; type: string; occurredAt: string | undefined; receivedAt: string; idempotencyKey: string; payload: Record<string, unknown> };

function brain() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    ...combineDepartments(RETAIL_DEPARTMENTS),
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => new Date(NOW),
  });
  return {
    memory,
    send: async (source: string, events: Raw[]) => {
      for (const e of events) await pipeline.ingest({ ...e, organizationId: ORG, source });
    },
    reason: () => pipeline.reason(ORG),
  };
}

function shopifyCustomer(contact: { email?: string; phone?: string }): ShopifyCustomer {
  return {
    id: "gid://shopify/Customer/7001",
    displayName: "Synthetic customer",
    updatedAt: "2026-11-01T12:00:00Z",
    emailMarketingConsent: null,
    defaultEmailAddress: contact.email === undefined ? null : { emailAddress: contact.email },
    defaultPhoneNumber: contact.phone === undefined ? null : { phoneNumber: contact.phone },
  };
}

function shopifyOrder(n: number, customer: number, amount: string): ShopifyOrder {
  const money = { shopMoney: { amount, currencyCode: "USD" } };
  return {
    id: `gid://shopify/Order/${n}`,
    name: `#${1000 + n}`,
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-01T12:00:00Z",
    processedAt: "2026-10-01T12:00:00Z",
    cancelledAt: null,
    sourceName: "web",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    paymentGatewayNames: ["shopify_payments"],
    currencyCode: "USD",
    totalPriceSet: money,
    customer: { id: `gid://shopify/Customer/${customer}` },
    lineItems: { nodes: [{ id: `gid://shopify/LineItem/${n}`, sku: "RG-1001", quantity: 1, variant: { id: "gid://shopify/ProductVariant/1" }, originalUnitPriceSet: money, totalDiscountSet: { shopMoney: { amount: "0.00" } } }] },
    refunds: [],
    fulfillments: [],
  };
}

function quoMessage(id: string, from: string, createdAt: string) {
  return { id, createdAt, updatedAt: createdAt, direction: "incoming", status: "received", from, to: ["+12125550100"], phoneNumberId: "PNstore1", conversationId: "CNconv1", userId: null, text: "Is my ring ready?", media: [] };
}

function twilioMessage(n: number, direction: string, customer: string, when = OPEN): TwilioMessage {
  const inbound = direction === "inbound";
  return {
    sid: sid("SM", n),
    direction,
    status: inbound ? "received" : "delivered",
    from: inbound ? customer : "+12125550100",
    to: inbound ? "+12125550100" : customer,
    num_segments: "1",
    num_media: "0",
    price: null,
    price_unit: null,
    error_code: null,
    date_sent: rfc2822(when),
    date_created: rfc2822(when),
  } as TwilioMessage;
}

function email(id: string, way: "sent" | "received", headers: Record<string, string>, when = OPEN) {
  return { id, threadId: `t${id}`, labelIds: way === "sent" ? ["SENT"] : ["INBOX"], internalDate: String(Date.parse(when)), payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } };
}

/** A message read over IMAP with these header fields, as the client hands it over. */
const imapAddressBook = { next: 1 };
function imapMessage(uid: number, headers: Record<string, string>, when = OPEN): ImapFetched {
  const lines = [...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), `Message-ID: <imap-${uid}@example.test>`];
  const d = new Date(when);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  const internalDate = `${two(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
  return { uid, flags: ["\\Seen"], internalDate, size: 500, header: new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`) };
}

const person = (address: string) => ({ emailAddress: { name: "Synthetic person", address } });
let graphIds = 0;
/** A message as Graph lists it in a folder, with these fields over a plain one. */
function outlookMessage(folder: "inbox" | "sentitems", fields: Record<string, unknown>): Record<string, unknown> {
  graphIds++;
  return { id: `AAMkAG${graphIds}`, conversationId: `AAQkAG${graphIds}`, isDraft: false, sentDateTime: OPEN, receivedDateTime: folder === "inbox" ? (fields.receivedDateTime ?? OPEN) : (fields.sentDateTime ?? OPEN), ...fields };
}
