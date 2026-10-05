/**
 * Every system Brain A plans to connect, carried over from the original
 * Integration Mapping sheet. Each connector must support historical import,
 * incremental sync, webhooks where the source offers them, retry with
 * checkpoints, and audit logging.
 */
export interface IntegrationSpec {
  id: string;
  name: string;
  domain: "crm" | "ecommerce" | "communication" | "documents" | "financial";
  historicalImportYears: number;
  webhooks: boolean;
  /** Names in secrets/manifest.json this integration needs. */
  settings: string[];
  status: "planned" | "deferred";
  note?: string;
}

export const INTEGRATIONS: IntegrationSpec[] = [
  { id: "shopify", name: "Shopify", domain: "ecommerce", historicalImportYears: 5, webhooks: true, settings: ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"], status: "planned" },
  { id: "inventory_pos", name: "Inventory and POS systems", domain: "ecommerce", historicalImportYears: 5, webhooks: true, settings: [], status: "planned", note: "System-specific; CSV import first" },
  { id: "stripe", name: "Stripe", domain: "financial", historicalImportYears: 5, webhooks: true, settings: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], status: "planned" },
  { id: "chase", name: "Chase business bank accounts and credit cards", domain: "financial", historicalImportYears: 6, webhooks: false, settings: ["CHASE_IMPORT_MODE", "CHASE_MANUAL_IMPORT_DIR"], status: "planned", note: "Manual CSV now; 5-6 years of PDF statements later" },
  { id: "hubspot", name: "HubSpot", domain: "crm", historicalImportYears: 5, webhooks: true, settings: ["HUBSPOT_ACCESS_TOKEN"], status: "planned" },
  { id: "monday", name: "Monday.com", domain: "crm", historicalImportYears: 5, webhooks: true, settings: ["MONDAY_API_TOKEN"], status: "planned" },
  { id: "custom_forms", name: "Custom forms", domain: "crm", historicalImportYears: 5, webhooks: true, settings: ["WEBHOOK_SIGNING_SECRET"], status: "planned" },
  { id: "gmail", name: "Gmail", domain: "communication", historicalImportYears: 5, webhooks: true, settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"], status: "planned" },
  { id: "google_workspace", name: "Google Workspace and Drive", domain: "documents", historicalImportYears: 5, webhooks: true, settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_DRIVE_ROOT_FOLDER_ID"], status: "planned" },
  { id: "slack", name: "Slack", domain: "communication", historicalImportYears: 5, webhooks: true, settings: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], status: "planned" },
  { id: "meta", name: "Instagram DMs, Facebook Messenger and WhatsApp Business", domain: "communication", historicalImportYears: 5, webhooks: true, settings: ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"], status: "deferred", note: "Waiting on Facebook account recovery" },
  { id: "anthropic", name: "Claude (Anthropic API)", domain: "documents", historicalImportYears: 0, webhooks: false, settings: ["ANTHROPIC_API_KEY"], status: "planned", note: "Reasoning, not a data source" },
];
