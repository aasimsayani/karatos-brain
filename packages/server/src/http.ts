import type { IncomingMessage } from "node:http";
import type { ZodError } from "zod";

/** An error a route answers with its own status and message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new HttpError(400, "request body must be JSON");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/**
 * A path segment as the id it encodes. Clients encode ids (recommendation
 * ids carry colons, entity ids spaces), so the route has to decode them
 * before looking anything up; a malformed escape is the caller's mistake.
 */
export function idFrom(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "the id in the path isn't validly encoded");
  }
}

/** A zod error's issues as { path, message } pairs for a 400's details. */
export const issuesOf = (error: ZodError) => error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
