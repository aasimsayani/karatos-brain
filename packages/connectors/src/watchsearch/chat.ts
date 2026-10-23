import { parseDate, type DateOrder } from "../files/values.js";

/**
 * Reads a WhatsApp chat export: the `.txt` file WhatsApp writes when someone
 * uses Export chat > Without media. iPhone and Android write different
 * lines, and each writes the date the way the phone's region does:
 *
 *   [22/10/2026, 14:03:21] Dealer: WTS 126610LN
 *   22/10/2026, 14:03 - Dealer: WTS 126610LN
 *   10/22/26, 2:03 PM - Dealer: WTS 126610LN
 *
 * A line that doesn't start with a timestamp continues the message above it.
 * System lines (someone joined, the encryption notice) carry a timestamp but
 * no sender, and are skipped. Times are the exporting phone's local clock,
 * read at the offset the instance gives.
 */

export interface ChatMessage {
  /** ISO time the message was sent. */
  at: string;
  /** The name or number WhatsApp shows for the sender. */
  sender: string;
  text: string;
  /** Line in the export where the message starts, from 1. */
  line: number;
}

/** "auto" works the order out from the dates in the file. */
export type ChatDateOrder = "auto" | Extract<DateOrder, "dmy" | "mdy">;

export class ChatExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatExportError";
  }
}

// Direction marks iPhone puts around names and attachments, and the narrow
// no-break space some phones write before AM and PM.
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const SPACES = /[   ]/g;

const STAMP = String.raw`(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s?([AaPp])\.?\s?[Mm]\.?)?`;
const IPHONE = new RegExp(String.raw`^\[${STAMP}\]\s(.*)$`);
const ANDROID = new RegExp(String.raw`^${STAMP}\s[-–]\s(.*)$`);
// A sender is followed by ": ". Names never hold a colon in an export, so the first one ends it.
const WITH_SENDER = /^([^:]{1,80}?):\s?(.*)$/;

/** What WhatsApp writes in place of media and removed messages. Nothing in these is an offer. */
const PLACEHOLDERS = [
  /^<media omitted>$/i,
  /^(image|video|audio|sticker|gif|document|contact card) omitted$/i,
  /^this message was deleted\.?$/i,
  /^you deleted this message\.?$/i,
  /^null$/i,
];
const EDITED = /\s*<this message was edited>$/i;

interface Stamp {
  a: number;
  b: number;
  year: string;
  hour: string;
  minute: string;
  second: string | undefined;
  meridiem: string | undefined;
  rest: string;
}

function stampOf(line: string): Stamp | null {
  const m = IPHONE.exec(line) ?? ANDROID.exec(line);
  if (!m) return null;
  return { a: Number(m[1]), b: Number(m[2]), year: m[3]!, hour: m[4]!, minute: m[5]!, second: m[6], meridiem: m[7], rest: m[8]! };
}

/**
 * The order the file's dates are in. A day over 12 settles it; a file whose
 * dates all have both parts at 12 or under can't be told apart, so it needs
 * the setting.
 */
export function chatDateOrder(stamps: readonly { a: number; b: number }[], setting: ChatDateOrder, fileName: string): "dmy" | "mdy" {
  const dmy = stamps.some((s) => s.a > 12);
  const mdy = stamps.some((s) => s.b > 12);
  if (dmy && mdy) throw new ChatExportError(`${fileName}: the dates mix day-first and month-first, so this isn't one WhatsApp export`);
  const found = dmy ? "dmy" : mdy ? "mdy" : null;
  if (setting !== "auto") {
    if (found && found !== setting) throw new ChatExportError(`${fileName}: the dates are ${found}, but WATCHSEARCH_DATE_ORDER says ${setting}`);
    return setting;
  }
  if (!found) throw new ChatExportError(`${fileName}: every date could be day-first or month-first; set WATCHSEARCH_DATE_ORDER to dmy or mdy`);
  return found;
}

const clean = (line: string) => line.replace(INVISIBLE, "").replace(SPACES, " ").replace(/\r$/, "");

/** The messages in one export, oldest first, without system lines or media placeholders. */
export function parseChat(text: string, options: { fileName: string; dateOrder?: ChatDateOrder | undefined; utcOffset?: string | undefined }): ChatMessage[] {
  const lines = text.split("\n").map(clean);
  const stamped = lines.map(stampOf);
  const order = chatDateOrder(stamped.filter((s): s is Stamp => s !== null), options.dateOrder ?? "auto", options.fileName);

  const messages: ChatMessage[] = [];
  let current: ChatMessage | null = null;
  const finish = () => {
    if (!current) return;
    current.text = current.text.replace(EDITED, "").trim();
    if (current.text && !PLACEHOLDERS.some((p) => p.test(current!.text))) messages.push(current);
    current = null;
  };

  lines.forEach((line, i) => {
    const s = stamped[i];
    if (!s) {
      // A continuation line; text before the first message (rare) is dropped.
      if (current) current.text += `\n${line}`;
      return;
    }
    finish();
    const [day, month] = order === "dmy" ? [s.a, s.b] : [s.b, s.a];
    const meridiem = s.meridiem ? ` ${s.meridiem.toLowerCase()}m` : "";
    const at = parseDate(`${day}/${month}/${s.year} ${s.hour}:${s.minute}:${s.second ?? "00"}${meridiem}`, "dmy", options.utcOffset ?? "Z");
    if (at === null) throw new ChatExportError(`${options.fileName}:${i + 1}: the timestamp isn't a real date and time`);
    const sent = WITH_SENDER.exec(s.rest);
    // No sender: a system line, such as the encryption notice or someone joining.
    if (!sent) return;
    current = { at, sender: sent[1]!.trim(), text: sent[2]!, line: i + 1 };
  });
  finish();
  return messages;
}
