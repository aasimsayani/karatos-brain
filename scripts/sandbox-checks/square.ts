import type { SandboxCheck } from "@karatos/core";
import { squareConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A Square developer account's sandbox seller, connected to the app over OAuth with the read scopes only.
// Always the sandbox host. Square keeps the same refresh token, so the secret doesn't need updating after a run.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "square",
  name: "Square",
  credentials: ["SANDBOX_SQUARE_APPLICATION_ID", "SANDBOX_SQUARE_APPLICATION_SECRET", "SANDBOX_SQUARE_REFRESH_TOKEN"],
  connector: (c) =>
    squareConnector({
      environment: "sandbox",
      applicationId: c.SANDBOX_SQUARE_APPLICATION_ID!,
      applicationSecret: c.SANDBOX_SQUARE_APPLICATION_SECRET!,
      refreshToken: c.SANDBOX_SQUARE_REFRESH_TOKEN!,
      customerKey: randomBytes(32).toString("hex"),
    }),
} satisfies SandboxCheck;
