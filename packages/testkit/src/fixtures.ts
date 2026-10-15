/**
 * Synthetic fixture builders. Every value is obviously fake: emails use the
 * reserved .test domain, phone numbers use the 555-01xx fictional range and
 * card numbers are never generated. `assertSynthetic` enforces this so a
 * real customer record can't slip into a fixture file.
 */

export interface FixtureBuilder<T extends object> {
  /** Builds the next record, numbered from 1, with optional overrides. */
  one(overrides?: Partial<T>): T;
  /** Builds `count` records; `overrides` gets each record's number. */
  many(count: number, overrides?: (n: number) => Partial<T>): T[];
  /** Restarts numbering at 1. */
  reset(): void;
}

export function fixtureBuilder<T extends object>(defaults: (n: number) => T): FixtureBuilder<T> {
  let n = 0;
  const one = (overrides: Partial<T> = {}): T => {
    n++;
    return { ...defaults(n), ...overrides };
  };
  return {
    one,
    many: (count, overrides) => Array.from({ length: count }, () => one(overrides?.(n + 1))),
    reset: () => {
      n = 0;
    },
  };
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Clearly fake values for fixtures. */
export const synthetic = {
  email: (n: number) => `customer${n}@example.test`,
  name: (n: number) => `Test Customer ${n}`,
  /** 555-0100 to 555-0199 is reserved for fiction. */
  phone: (n: number) => `+1 212 555 01${pad(n % 100, 2)}`,
  sku: (n: number) => `SKU-TEST-${pad(n, 4)}`,
  /** A fixed instant plus n minutes, so fixtures don't depend on the clock. */
  isoTime: (n: number, start = "2026-01-01T00:00:00Z") => new Date(Date.parse(start) + n * 60_000).toISOString(),
};

export class RealLookingDataError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`fixture value at ${path} looks real: ${reason}`);
    this.name = "RealLookingDataError";
  }
}

const SAFE_EMAIL_DOMAINS = /@(example\.(test|com|org|net)|[a-z0-9-]+\.test|[a-z0-9-]+\.example|[a-z0-9-]+\.invalid)$/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const DIGIT_RUN = /\d[\d -]{11,22}\d/g;
const US_PHONE = /(?<!\d)(?:\+?1[ .-]?)?\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})(?!\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function checkString(value: string, path: string): void {
  for (const email of value.match(EMAIL) ?? []) {
    if (!SAFE_EMAIL_DOMAINS.test(email)) throw new RealLookingDataError(path, `email ${email} is not on a reserved test domain`);
  }
  for (const run of value.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      throw new RealLookingDataError(path, "contains a number that passes the card-number checksum");
    }
  }
  for (const match of value.matchAll(US_PHONE)) {
    const [, area, exchange, line] = match;
    const fictional = exchange === "555" && Number(line) >= 100 && Number(line) <= 199;
    if (!fictional && /^[2-9]\d\d$/.test(area!) && /^[2-9]\d\d$/.test(exchange!)) {
      throw new RealLookingDataError(path, `phone number outside the 555-01xx fictional range`);
    }
  }
}

/** Throws if any string in `value` holds a real-looking email, card number or phone number. */
export function assertSynthetic(value: unknown, path = "$"): void {
  if (typeof value === "string") return checkString(value, path);
  if (Array.isArray(value)) return value.forEach((item, i) => assertSynthetic(item, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertSynthetic(item, `${path}.${key}`);
  }
}
