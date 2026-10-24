/**
 * A reader for ANSI X12 interchanges: the ISA and IEA envelope, GS and GE
 * functional groups, and ST and SE transaction sets. The delimiters come from
 * the fixed-width ISA segment, as the standard requires, so any partner's
 * choice of separators reads the same way. Every control number and count is
 * checked: an envelope that doesn't add up stops the file, and a transaction
 * set whose own trailer doesn't add up is kept with the problem named, so the
 * connector can dead-letter just that document.
 */

export interface X12Segment {
  /** The segment id, such as "BEG" or "PO1". */
  id: string;
  /** Elements after the id: `elements[0]` is the X12 element 01. */
  elements: string[];
}

export interface X12Party {
  /** ISA05 or ISA07, such as "ZZ" (mutually defined) or "01" (DUNS). */
  qualifier: string;
  id: string;
}

export interface X12Interchange {
  sender: X12Party;
  receiver: X12Party;
  /** ISA13. */
  control: string;
  /** ISA15: "P" for production, "T" for test. */
  usage: string;
  groups: X12Group[];
}

export interface X12Group {
  /** GS01, such as "PO" for purchase orders. */
  functionalId: string;
  /** GS06. */
  control: string;
  /** GS08, such as "004010". */
  version: string;
  transactions: X12Transaction[];
}

export interface X12Transaction {
  /** ST01, such as "850". */
  set: string;
  /** ST02. */
  control: string;
  /** Segments between ST and SE, without either. */
  segments: X12Segment[];
  /** What is wrong with this set's own trailer, if anything. */
  problems: string[];
}

export class X12Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X12Error";
  }
}

/** The ISA segment is always 106 characters: 105 up to its terminator, which is the 106th. */
const ISA_LENGTH = 106;

interface Delimiters {
  element: string;
  component: string;
  segment: string;
}

function delimitersOf(text: string, at: number): Delimiters {
  if (text.length - at < ISA_LENGTH) throw new X12Error(`ISA segment at character ${at + 1} is shorter than ${ISA_LENGTH} characters`);
  const element = text[at + 3]!;
  const component = text[at + 104]!;
  const segment = text[at + 105]!;
  const isa = text.slice(at, at + 105).split(element);
  if (isa.length !== 17) throw new X12Error(`ISA segment at character ${at + 1} has ${isa.length - 1} elements, expected 16`);
  if (/[A-Za-z0-9 ]/.test(element) || /[A-Za-z0-9]/.test(segment) || new Set([element, component, segment]).size !== 3) {
    throw new X12Error(`ISA segment at character ${at + 1} does not declare usable delimiters`);
  }
  return { element, component, segment };
}

/** One segment's text as its id and elements. Line breaks partners put between segments are dropped. */
function toSegment(raw: string, d: Delimiters): X12Segment {
  const [id, ...elements] = raw.replace(/^[\r\n]+|[\r\n]+$/g, "").split(d.element);
  return { id: id!.trim(), elements };
}

/** The value of element `n` (from 1), trimmed; empty when absent. */
export const el = (segment: X12Segment | undefined, n: number) => segment?.elements[n - 1]?.trim() ?? "";

function expectCount(label: string, declared: string, actual: number, problems: string[]) {
  if (!/^\d+$/.test(declared) || Number(declared) !== actual) problems.push(`${label} says ${declared || "nothing"}, found ${actual}`);
}

/**
 * Reads every interchange in a file. Throws X12Error when the envelope is
 * broken: no ISA, a group or interchange left open, or a GE or IEA whose
 * count or control number doesn't match. A transaction set whose SE doesn't
 * match is returned with `problems` filled in instead.
 */
export function parseX12(text: string): X12Interchange[] {
  const source = text.replace(/^\uFEFF/, "");
  const interchanges: X12Interchange[] = [];
  let at = source.search(/\S/);
  while (at !== -1) {
    if (source.slice(at, at + 3) !== "ISA") throw new X12Error(`expected an ISA segment at character ${at + 1}`);
    const d = delimitersOf(source, at);
    const segments: X12Segment[] = [];
    let pos = at;
    for (;;) {
      const stop = source.indexOf(d.segment, pos);
      if (stop === -1) throw new X12Error(`interchange at character ${at + 1} has no IEA trailer`);
      const segment = toSegment(source.slice(pos, stop), d);
      pos = stop + 1;
      if (segment.id === "") continue;
      segments.push(segment);
      if (segment.id === "IEA") break;
    }
    interchanges.push(readInterchange(segments));
    const rest = source.slice(pos).search(/\S/);
    at = rest === -1 ? -1 : pos + rest;
  }
  return interchanges;
}

function readInterchange(segments: X12Segment[]): X12Interchange {
  const isa = segments[0]!;
  const iea = segments[segments.length - 1]!;
  if (iea.id !== "IEA") throw new X12Error(`interchange ${el(isa, 13)} does not end with IEA`);
  const interchange: X12Interchange = {
    sender: { qualifier: el(isa, 5), id: el(isa, 6) },
    receiver: { qualifier: el(isa, 7), id: el(isa, 8) },
    control: el(isa, 13),
    usage: el(isa, 15),
    groups: [],
  };
  if (el(iea, 2) !== interchange.control) throw new X12Error(`interchange ${interchange.control} closes with IEA control number ${el(iea, 2)}`);

  let group: X12Group | null = null;
  let transaction: X12Transaction | null = null;
  let segmentCount = 0;
  for (const segment of segments.slice(1, -1)) {
    if (segment.id === "GS") {
      if (group) throw new X12Error(`interchange ${interchange.control}: group ${group.control} has no GE before the next GS`);
      group = { functionalId: el(segment, 1), control: el(segment, 6), version: el(segment, 8), transactions: [] };
    } else if (segment.id === "GE") {
      if (!group) throw new X12Error(`interchange ${interchange.control}: GE with no open group`);
      if (transaction) throw new X12Error(`interchange ${interchange.control}: transaction ${transaction.control} has no SE before GE`);
      if (el(segment, 2) !== group.control) throw new X12Error(`group ${group.control} closes with GE control number ${el(segment, 2)}`);
      const problems: string[] = [];
      expectCount(`GE in group ${group.control}`, el(segment, 1), group.transactions.length, problems);
      if (problems.length) throw new X12Error(`${problems[0]} transaction sets`);
      interchange.groups.push(group);
      group = null;
    } else if (segment.id === "ST") {
      if (!group) throw new X12Error(`interchange ${interchange.control}: ST outside a functional group`);
      if (transaction) throw new X12Error(`interchange ${interchange.control}: transaction ${transaction.control} has no SE before the next ST`);
      transaction = { set: el(segment, 1), control: el(segment, 2), segments: [], problems: [] };
      segmentCount = 1;
    } else if (segment.id === "SE") {
      if (!transaction || !group) throw new X12Error(`interchange ${interchange.control}: SE with no open transaction set`);
      segmentCount++;
      expectCount(`SE in transaction ${transaction.control}`, el(segment, 1), segmentCount, transaction.problems);
      if (el(segment, 2) !== transaction.control) transaction.problems.push(`SE control number ${el(segment, 2) || "is missing"}, expected ${transaction.control}`);
      group.transactions.push(transaction);
      transaction = null;
    } else if (transaction) {
      transaction.segments.push(segment);
      segmentCount++;
    } else {
      throw new X12Error(`interchange ${interchange.control}: ${segment.id} segment outside a transaction set`);
    }
  }
  if (transaction) throw new X12Error(`interchange ${interchange.control}: transaction ${transaction.control} has no SE`);
  if (group) throw new X12Error(`interchange ${interchange.control}: group ${group.control} has no GE`);
  const problems: string[] = [];
  expectCount(`IEA in interchange ${interchange.control}`, el(iea, 1), interchange.groups.length, problems);
  if (problems.length) throw new X12Error(`${problems[0]} functional groups`);
  return interchange;
}
