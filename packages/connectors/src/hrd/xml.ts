/**
 * A small, strict reader for the XML that MyHRD answers with: elements,
 * text and the five named entities plus numeric ones. It reads nothing
 * else on purpose. A document type declaration, an entity of its own or a
 * processing instruction past the XML declaration is an error, so there is
 * nothing to expand or fetch. Attributes are read past and not kept, since
 * the report data is all in elements. Element names compare without case:
 * HRD's own examples spell some names two ways (Item0 and item0).
 */

export interface XmlElement {
  name: string;
  children: XmlElement[];
  /** The element's own text, entities read, trimmed. */
  text: string;
}

/** Larger answers are refused rather than read: a report is a few kilobytes. */
export const XML_MAX_LENGTH = 2_000_000;
const MAX_DEPTH = 32;
const NAME = /^[A-Za-z_][\w.:-]*/;
/** One attribute, read where the reader stands (sticky). */
const ATTR = /[A-Za-z_][\w.:-]*\s*=\s*("[^"<]*"|'[^'<]*')/y;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

function entities(raw: string): string {
  return raw.replace(/&([^;&\s]{0,10});?/g, (whole, ref: string) => {
    if (!whole.endsWith(";")) throw new XmlError("an & that starts no entity");
    const code = /^#(\d{1,7})$/.exec(ref)?.[1] ?? (/^#x([0-9a-f]{1,6})$/i.exec(ref) ? String(parseInt(ref.slice(2), 16)) : undefined);
    if (code !== undefined) {
      const n = Number(code);
      if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new XmlError("a character reference out of range");
      return String.fromCodePoint(n);
    }
    if (Object.hasOwn(NAMED, ref)) return NAMED[ref]!;
    throw new XmlError("an entity XML doesn't define");
  });
}

/** Reads one document into its root element. */
export function parseXml(source: string): XmlElement {
  if (source.length > XML_MAX_LENGTH) throw new XmlError("the document is too large");
  let i = 0;
  // A byte order mark counts as white space, so it is read past like any.
  const s = source;
  const skipSpace = () => {
    while (/\s/.test(s[i] ?? "")) i++;
  };
  /** Comments may sit between elements; they are read past. */
  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (!s.startsWith("<!--", i)) return;
      const end = s.indexOf("-->", i + 4);
      if (end < 0) throw new XmlError("a comment that doesn't end");
      i = end + 3;
    }
  };

  skipSpace();
  if (s.startsWith("<?xml", i)) {
    const end = s.indexOf("?>", i);
    if (end < 0) throw new XmlError("an XML declaration that doesn't end");
    i = end + 2;
  }

  function element(depth: number): XmlElement {
    if (depth > MAX_DEPTH) throw new XmlError("elements nested too deep");
    if (s[i] !== "<") throw new XmlError("expected an element");
    const name = NAME.exec(s.slice(i + 1, i + 200))?.[0];
    if (!name) throw new XmlError("an element without a name");
    i += 1 + name.length;
    // Attributes are read past: quoted values may hold > and /.
    for (;;) {
      skipSpace();
      if (s[i] === ">" || s.startsWith("/>", i)) break;
      ATTR.lastIndex = i;
      if (!ATTR.exec(s)) throw new XmlError(`element ${name} has a malformed attribute`);
      i = ATTR.lastIndex;
    }
    const node: XmlElement = { name, children: [], text: "" };
    if (s.startsWith("/>", i)) {
      i += 2;
      return node;
    }
    i++;
    let text = "";
    for (;;) {
      const lt = s.indexOf("<", i);
      if (lt < 0) throw new XmlError(`element ${name} doesn't end`);
      text += s.slice(i, lt);
      i = lt;
      if (s.startsWith("</", i)) {
        const close = new RegExp(`^</${name.replace(/[.:-]/g, "\\$&")}\\s*>`).exec(s.slice(i, i + name.length + 64));
        if (!close) throw new XmlError(`element ${name} ends with another element's name`);
        i += close[0].length;
        node.text = entities(text).trim();
        return node;
      }
      if (s.startsWith("<!--", i)) {
        skipMisc();
        continue;
      }
      if (s.startsWith("<![CDATA[", i)) {
        const end = s.indexOf("]]>", i);
        if (end < 0) throw new XmlError("a CDATA section that doesn't end");
        text += s.slice(i + 9, end).replace(/&/g, "&amp;");
        i = end + 3;
        continue;
      }
      if (s.startsWith("<!", i) || s.startsWith("<?", i)) throw new XmlError("a declaration or processing instruction inside the document");
      node.children.push(element(depth + 1));
    }
  }

  skipMisc();
  if (s.startsWith("<!", i) || s.startsWith("<?", i)) throw new XmlError("a document type declaration or processing instruction");
  const root = element(0);
  skipMisc();
  if (i !== s.length) throw new XmlError("content after the root element");
  return root;
}

/** The first child with this name, any case. */
export function child(node: XmlElement | undefined, name: string): XmlElement | undefined {
  const want = name.toLowerCase();
  return node?.children.find((c) => c.name.toLowerCase() === want);
}

/** The element at a path of names from `node`, trying each spelling given for a step ("Results|Result"). */
export function at(node: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
  return path.reduce<XmlElement | undefined>((n, step) => step.split("|").map((name) => child(n, name)).find((c) => c !== undefined), node);
}

/** The text at a path, or undefined when the element is missing or empty. */
export function textAt(node: XmlElement | undefined, ...path: string[]): string | undefined {
  const t = at(node, ...path)?.text;
  return t ? t : undefined;
}
