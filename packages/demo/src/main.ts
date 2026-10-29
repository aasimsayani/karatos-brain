import { createServer } from "node:http";
import { startDemo } from "./server.js";

// The console's demo service holds the same key; generate it in Railway and reference it from both.
const apiKey = process.env.DEMO_API_KEY?.trim() ?? "";
if (apiKey.length < 32) {
  console.error("DEMO_API_KEY must be set to at least 32 random characters");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);

const { handler } = await startDemo({ apiKey });
createServer(handler).listen(port, () => console.log(`demo store listening on :${port}`));
