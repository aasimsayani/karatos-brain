import type { SandboxCheck } from "@karatos/core";
import { calendlyConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Calendly account for testing, with a few synthetic bookings, and a personal access token with the users:read and scheduled_events:read scopes.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "calendly",
  name: "Calendly",
  credentials: ["SANDBOX_CALENDLY_ACCESS_TOKEN"],
  connector: (c) => calendlyConnector({ token: c.SANDBOX_CALENDLY_ACCESS_TOKEN!, customerKey: randomBytes(32).toString("hex") }),
} satisfies SandboxCheck;
