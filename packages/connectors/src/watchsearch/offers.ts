/**
 * Finds the watch offers in a dealer's WhatsApp message. Dealers post in a
 * loose shorthand, one watch per line or one per message:
 *
 *   WTS Rolex 126610LN 2023 full set $14,500
 *   LF AP 15500ST blue, any year
 *   Patek 5711/1A-010 B&P 2021 HKD 1.05m
 *
 * A line is an offer when it names a brand and a reference, and either says
 * which way it goes (selling or looking for, on the line or at the top of
 * the message) or carries a price, which only a seller writes. Everything
 * else in a message, chatter included, is dropped. Only these fields are
 * kept, never the message's own words.
 */

export type OfferSide = "selling" | "looking_for";
export type OfferCondition = "new" | "pre_owned";
export type OfferSet = "full_set" | "watch_only" | "box_only" | "papers_only";

export interface WatchOffer {
  side: OfferSide;
  brand: string;
  reference: string;
  /** Asking price in the currency's minor unit (cents, pence). */
  priceMinor?: number;
  /** ISO 4217 code. */
  currency?: string;
  year?: number;
  condition?: OfferCondition;
  set?: OfferSet;
  /** Which line of the message the offer is on, from 0. */
  part: number;
}

/**
 * Brands by the names and shorthand dealers use. Two-letter shorthand counts
 * only in capitals, so "ap" in a sentence isn't Audemars Piguet.
 */
const BRANDS: [brand: string, names: string[], shorthand?: string[]][] = [
  ["Rolex", ["rolex"], ["RLX"]],
  ["Audemars Piguet", ["audemars piguet", "audemars", "royal oak"], ["AP"]],
  ["Patek Philippe", ["patek philippe", "patek"], ["PP", "PATEK"]],
  ["Richard Mille", ["richard mille"], ["RM"]],
  ["Vacheron Constantin", ["vacheron constantin", "vacheron"], ["VC"]],
  ["A. Lange & Söhne", ["a. lange & söhne", "a. lange & sohne", "lange & söhne", "lange & sohne", "lange"], ["ALS"]],
  ["F.P. Journe", ["f.p. journe", "fp journe", "journe"], ["FPJ"]],
  ["Omega", ["omega"]],
  ["Cartier", ["cartier"]],
  ["Tudor", ["tudor"]],
  ["IWC", ["iwc"]],
  ["Jaeger-LeCoultre", ["jaeger-lecoultre", "jaeger lecoultre", "jaeger"], ["JLC"]],
  ["Hublot", ["hublot"]],
  ["Panerai", ["panerai"]],
  ["Breitling", ["breitling"]],
  ["Breguet", ["breguet"]],
  ["Blancpain", ["blancpain"]],
  ["Grand Seiko", ["grand seiko"], ["GS"]],
  ["Zenith", ["zenith"]],
  ["Chopard", ["chopard"]],
  ["Bulgari", ["bulgari", "bvlgari"]],
  ["TAG Heuer", ["tag heuer", "heuer"]],
  ["H. Moser & Cie", ["h. moser", "moser"]],
  ["MB&F", ["mb&f"]],
  ["Ulysse Nardin", ["ulysse nardin"]],
  ["Girard-Perregaux", ["girard-perregaux", "girard perregaux"]],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => `(?<![\\p{L}\\p{N}])${escape(s)}(?![\\p{L}\\p{N}])`;
const BRAND_PATTERNS = BRANDS.map(([brand, names, shorthand]) => ({
  brand,
  names: new RegExp(names.map(word).join("|"), "iu"),
  shorthand: shorthand ? new RegExp(shorthand.map(word).join("|"), "u") : null,
}));

/** The brand a line names, earliest in the line first. */
export function brandIn(line: string): { brand: string; index: number; length: number } | null {
  let best: { brand: string; index: number; length: number } | null = null;
  for (const p of BRAND_PATTERNS) {
    for (const re of [p.names, p.shorthand]) {
      const m = re?.exec(line);
      if (m && (!best || m.index < best.index)) best = { brand: p.brand, index: m.index, length: m[0].length };
    }
  }
  return best;
}

const SELLING = /(?<![\p{L}])(wts|for sale|selling|sell|available|avail|in stock|offering|offer)(?![\p{L}])/iu;
const LOOKING = /(?<![\p{L}])(wtb|lf|lfw|looking for|looking|wanted|want|searching|search|need|iso|buying|buy)(?![\p{L}])/iu;

/** Which way a line goes, when it says. A line that says both is left undecided. */
export function sideIn(line: string): OfferSide | null {
  const sells = SELLING.test(line);
  const looks = LOOKING.test(line);
  if (sells === looks) return null;
  return sells ? "selling" : "looking_for";
}

const CURRENCY_SIGNS: [RegExp, string][] = [
  [/^US\$$/i, "USD"],
  [/^HK\$$/i, "HKD"],
  [/^S\$$/i, "SGD"],
  [/^\$$/, "USD"],
  [/^€$/, "EUR"],
  [/^£$/, "GBP"],
  [/^CHF$/i, "CHF"],
];
const CODES = ["USD", "EUR", "GBP", "HKD", "CHF", "AED", "SGD", "JPY", "CAD", "AUD"];
// Grouped thousands ("14,500", "14 500", "14'500") or a plain number with an optional decimal part.
const NUMBER = String.raw`\d{1,3}(?:[,.' ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,3})?`;
const MULTIPLIER = String.raw`(k|m|mil)?`;
const SIGN = String.raw`US\$|HK\$|S\$|\$|€|£`;
const PRICE_BEFORE = new RegExp(String.raw`(?<![\p{L}\p{N}])(${SIGN}|${CODES.join("|")})\s?(${NUMBER})\s?${MULTIPLIER}(?![\p{L}\p{N}])`, "iu");
const PRICE_AFTER = new RegExp(String.raw`(?<![\p{L}\p{N}.,])(${NUMBER})\s?${MULTIPLIER}\s?(${SIGN}|${CODES.join("|")})(?![\p{L}\p{N}])`, "iu");
const BARE_PRICE = new RegExp(String.raw`(?<![\p{L}\p{N}.,/-])(\d{1,4}(?:[.,]\d{1,3})?)\s?(k)(?![\p{L}\p{N}])(?!\s*(gold|yg|wg|rg|rose|white|yellow|everose|pink|solid))`, "iu");

/** Minor units in a currency without them. */
const NO_MINOR = new Set(["JPY"]);

/**
 * "14,500", "14.500", "14 500", "14'500" → 14500; "14.5" with k → 14500;
 * "1.05" with m → 1050000. Null when the separators don't read one way.
 */
export function amountOf(digits: string, multiplier: string | undefined): number | null {
  const d = digits.replace(/ /g, "");
  const scale = !multiplier ? 1 : multiplier.toLowerCase() === "k" ? 1_000 : 1_000_000;
  if (scale > 1) {
    // With k or m the separator is a decimal point: 14.5k, 14,5k.
    if (!/^\d+(?:[.,]\d+)?$/.test(d)) return null;
    return Math.round(Number(d.replace(",", ".")) * scale);
  }
  if (/^\d+$/.test(d)) return Number(d);
  // Ungrouped digits or thousands grouped by one separator, with an optional two-digit decimal part.
  const grouped = /^(\d+|\d{1,3}(?:([,.'])\d{3})+)(?:([.,])(\d{2}))?$/.exec(d);
  if (!grouped || (grouped[2] && grouped[3] && grouped[2] === grouped[3])) return null;
  const whole = Number(grouped[1]!.replace(/[,.']/g, ""));
  return whole + (grouped[4] ? Number(grouped[4]) / 100 : 0);
}

function currencyOf(token: string): string | null {
  const upper = token.toUpperCase();
  if (CODES.includes(upper)) return upper;
  return CURRENCY_SIGNS.find(([re]) => re.test(token))?.[1] ?? null;
}

const toMinor = (amount: number, currency: string) => Math.round(NO_MINOR.has(currency) ? amount : amount * 100);

/**
 * The asking price on a line and where it sits. A bare "14.5k" is read in
 * `defaultCurrency` when there is one, and otherwise left out: a price is
 * only kept when its currency is known.
 */
export function priceIn(line: string, defaultCurrency?: string): { priceMinor: number; currency: string; index: number; length: number } | null {
  const before = PRICE_BEFORE.exec(line);
  const after = PRICE_AFTER.exec(line);
  const candidates = [
    before && { currency: currencyOf(before[1]!), amount: amountOf(before[2]!, before[3]), index: before.index, length: before[0].length },
    after && { currency: currencyOf(after[3]!), amount: amountOf(after[1]!, after[2]), index: after.index, length: after[0].length },
  ].filter((c): c is { currency: string | null; amount: number | null; index: number; length: number } => !!c && c.currency !== null && c.amount !== null && c.amount > 0);
  const found = candidates.sort((a, b) => a.index - b.index)[0];
  if (found) return { priceMinor: toMinor(found.amount!, found.currency!), currency: found.currency!, index: found.index, length: found.length };
  if (!defaultCurrency) return null;
  const bare = BARE_PRICE.exec(line);
  const amount = bare ? amountOf(bare[1]!, bare[2]) : null;
  if (!bare || !amount) return null;
  return { priceMinor: toMinor(amount, defaultCurrency), currency: defaultCurrency, index: bare.index, length: bare[0].length };
}

const YEAR = /(?<![\p{L}\p{N}.,/-])(?:(?:0?[1-9]|1[0-2])[/.])?((?:19[5-9]|20[0-4])\d)(?![\p{L}\p{N}.,/-])/u;
const YEAR_ON_CARD = /(?<![\p{N}])(?:0?[1-9]|1[0-2])\/((?:19[5-9]|20[0-4])\d)(?![\p{N}])/u;

/** The year on the watch's card or papers: "2023", "03/2023". */
export function yearIn(line: string, now: Date): { year: number; index: number; length: number } | null {
  const m = YEAR_ON_CARD.exec(line) ?? YEAR.exec(line);
  if (!m) return null;
  const year = Number(m[1]);
  if (year > now.getUTCFullYear() + 1) return null;
  return { year, index: m.index, length: m[0].length };
}

const NEW = /(?<![\p{L}])(bnib|brand new|unworn|nos|new)(?![\p{L}])(?!\s+(card|model|dial|version|release|old stock))/iu;
const PRE_OWNED = /(?<![\p{L}])(pre-?owned|preowned|used|worn|mint|lnib|like new|excellent|very good|good condition|polished|unpolished)(?![\p{L}])/iu;

export function conditionIn(line: string): OfferCondition | undefined {
  // "Like new" is pre-owned: test it first.
  if (PRE_OWNED.test(line)) return "pre_owned";
  if (NEW.test(line)) return "new";
  return undefined;
}

const SETS: [RegExp, OfferSet][] = [
  [/(?<![\p{L}])(watch only|naked|head only|no box|no papers)(?![\p{L}])/iu, "watch_only"],
  [/(?<![\p{L}])(box only)(?![\p{L}])/iu, "box_only"],
  [/(?<![\p{L}])(papers only|card only)(?![\p{L}])/iu, "papers_only"],
  [/(?<![\p{L}])(full set|fullset|complete set|fs|b\s?&\s?p|box (and|&) papers?|box\s?\+\s?papers?)(?![\p{L}])/iu, "full_set"],
];

export function setIn(line: string): OfferSet | undefined {
  return SETS.find(([re]) => re.test(line))?.[1];
}

/**
 * A reference number: Rolex 126610LN, AP 15500ST.OO.1220ST.01, Patek
 * 5711/1A-010, Omega 310.30.42.50.01.001, Cartier WSSA0018, Richard Mille
 * RM 011. At least three digits, so a model name or a size like "41mm"
 * isn't one. Years and prices are blanked out of the line first.
 */
const REFERENCE = /(?<![\p{L}\p{N}])(RM\s?\d{2,3}(?:-\d{2})?|[A-Z]{0,6}\d[A-Z0-9]*(?:[./-][A-Z0-9]+){0,5})(?![\p{L}\p{N}])/giu;

export function referenceIn(line: string): string | null {
  for (const m of line.matchAll(REFERENCE)) {
    const ref = m[1]!.replace(/\s/g, "").toUpperCase();
    const digits = ref.replace(/\D/g, "").length;
    if (digits < 3 || ref.length > 30) continue;
    // Sizes and measures: 41mm, 40.5mm, 18k gold.
    if (/^\d+(\.\d+)?(MM|CM|K|KT|CT|G)$/.test(ref)) continue;
    // A bare number of nine or more digits is a phone number.
    if (/^\d{9,}$/.test(ref)) continue;
    return ref;
  }
  return null;
}

/** "+852 9123 4567": a dealer's number, blanked before looking for a reference. */
const PHONE = /\+\s?\d[\d\s().-]{6,}\d/g;

const blank = (line: string, at: { index: number; length: number } | null) => (at ? line.slice(0, at.index) + " ".repeat(at.length) + line.slice(at.index + at.length) : line);

export interface OfferOptions {
  /** Currency for a bare "14.5k", when the store's groups use one. */
  defaultCurrency?: string | undefined;
  now: Date;
}

/** The offers in one message, at most one per line. */
export function offersIn(text: string, options: OfferOptions): WatchOffer[] {
  const lines = text.split("\n");
  // A side said on its own line (or the first line) holds for the lines under it.
  let messageSide: OfferSide | null = null;
  const offers: WatchOffer[] = [];
  lines.forEach((raw, part) => {
    const line = raw.trim();
    if (!line) return;
    const brand = brandIn(line);
    const side = sideIn(line);
    if (!brand) {
      if (side) messageSide = side;
      return;
    }
    const plain = line.replace(PHONE, (m) => " ".repeat(m.length));
    const price = priceIn(plain, options.defaultCurrency);
    const year = yearIn(blank(plain, price), options.now);
    const rest = blank(blank(blank(plain, brand.brand === "Richard Mille" ? null : brand), price), year);
    const reference = referenceIn(rest);
    if (!reference) {
      if (side) messageSide = side;
      return;
    }
    const lineSide = side ?? messageSide ?? (price ? "selling" : null);
    if (!lineSide) return;
    const offer: WatchOffer = { side: lineSide, brand: brand.brand, reference, part };
    if (price) {
      offer.priceMinor = price.priceMinor;
      offer.currency = price.currency;
    }
    if (year) offer.year = year.year;
    const condition = conditionIn(line);
    if (condition) offer.condition = condition;
    const set = setIn(line);
    if (set) offer.set = set;
    offers.push(offer);
  });
  return offers;
}
