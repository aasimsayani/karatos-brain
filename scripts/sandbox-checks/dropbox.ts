import type { SandboxCheck } from "@karatos/core";
import { dropboxConnector } from "@karatos/connectors";

// A free Dropbox Basic account with a /KaratOS Test folder of synthetic statements and invoices, approved for a scoped test app with only files.metadata.read and files.content.read.
export default {
  integration: "dropbox",
  name: "Dropbox",
  credentials: ["SANDBOX_DROPBOX_APP_KEY", "SANDBOX_DROPBOX_APP_SECRET", "SANDBOX_DROPBOX_REFRESH_TOKEN"],
  connector: (c) =>
    dropboxConnector({
      appKey: c.SANDBOX_DROPBOX_APP_KEY!,
      appSecret: c.SANDBOX_DROPBOX_APP_SECRET!,
      refreshToken: c.SANDBOX_DROPBOX_REFRESH_TOKEN!,
      folder: "/KaratOS Test",
    }),
} satisfies SandboxCheck;
