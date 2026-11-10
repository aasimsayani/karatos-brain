import type { SandboxCheck } from "@karatos/core";
import { microsoftOneDriveConnector } from "@karatos/connectors";

// A Microsoft 365 test tenant with a KaratOS Test SharePoint site of synthetic statements and invoices, and an app given Sites.Selected with the read role on that site only.
export default {
  integration: "microsoft_onedrive",
  name: "Microsoft OneDrive and SharePoint",
  credentials: ["SANDBOX_MICROSOFT_ONEDRIVE_TENANT_ID", "SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_ID", "SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_SECRET", "SANDBOX_MICROSOFT_ONEDRIVE_DRIVE_ID"],
  connector: (c) =>
    microsoftOneDriveConnector({
      tenantId: c.SANDBOX_MICROSOFT_ONEDRIVE_TENANT_ID!,
      clientId: c.SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_ID!,
      clientSecret: c.SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_SECRET!,
      driveId: c.SANDBOX_MICROSOFT_ONEDRIVE_DRIVE_ID!,
    }),
} satisfies SandboxCheck;
