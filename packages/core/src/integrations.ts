/**
 * Every system Brain A plans to connect. The first group was carried over
 * from the original Brain A Integration Mapping sheet; the rest is the wider
 * jewelry-industry stack used by retailers, wholesalers and manufacturers.
 * Each connector must support historical import, incremental sync, webhooks
 * where the source offers them, retry with checkpoints, and audit logging.
 */
export type IntegrationDomain =
  | "crm"
  | "ecommerce"
  | "communication"
  | "documents"
  | "financial"
  | "pos"
  | "marketing"
  | "diamonds"
  | "suppliers"
  | "grading"
  | "pricing"
  | "erp"
  | "edi"
  | "insurance"
  | "shipping";

/** The kinds of business that run a system. */
export type BusinessSegment = "retail" | "wholesale" | "manufacturing";

/**
 * How a connector can reach the system:
 * - public_api: documented API a customer can authorize on their own
 * - partner: API exists but needs a vendor partnership or approval
 * - edi: X12 or XML documents through a VAN, AS2 or SFTP
 * - file: scheduled exports (CSV, statements) are the only route today
 * - unknown: no access route confirmed yet
 */
export type IntegrationAccess = "public_api" | "partner" | "edi" | "file" | "unknown";

export interface IntegrationSpec {
  id: string;
  name: string;
  domain: IntegrationDomain;
  segments: BusinessSegment[];
  access: IntegrationAccess;
  historicalImportYears: number;
  webhooks: boolean;
  /** Names in secrets/manifest.json this integration needs. */
  settings: string[];
  status: "planned" | "deferred";
  note?: string;
}

const ALL: BusinessSegment[] = ["retail", "wholesale", "manufacturing"];

export const INTEGRATIONS: IntegrationSpec[] = [
  // Brain A Integration Mapping sheet
  { id: "shopify", name: "Shopify", domain: "ecommerce", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"], status: "planned" },
  { id: "inventory_pos", name: "Inventory and POS systems", domain: "ecommerce", segments: ["retail"], access: "file", historicalImportYears: 5, webhooks: true, settings: [], status: "planned", note: "System-specific; CSV import first" },
  { id: "stripe", name: "Stripe", domain: "financial", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], status: "planned" },
  { id: "chase", name: "Chase business bank accounts and credit cards", domain: "financial", segments: ALL, access: "file", historicalImportYears: 6, webhooks: false, settings: ["CHASE_IMPORT_MODE", "CHASE_MANUAL_IMPORT_DIR"], status: "planned", note: "Manual CSV now; 5-6 years of PDF statements later" },
  { id: "hubspot", name: "HubSpot", domain: "crm", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["HUBSPOT_ACCESS_TOKEN"], status: "planned" },
  { id: "monday", name: "Monday.com", domain: "crm", segments: ALL, access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["MONDAY_API_TOKEN"], status: "planned" },
  { id: "custom_forms", name: "Custom forms", domain: "crm", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["WEBHOOK_SIGNING_SECRET"], status: "planned" },
  { id: "gmail", name: "Gmail", domain: "communication", segments: ALL, access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"], status: "planned" },
  { id: "google_workspace", name: "Google Workspace and Drive", domain: "documents", segments: ALL, access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_DRIVE_ROOT_FOLDER_ID"], status: "planned" },
  { id: "slack", name: "Slack", domain: "communication", segments: ALL, access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], status: "planned" },
  { id: "meta", name: "Instagram DMs, Facebook Messenger and WhatsApp Business", domain: "communication", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"], status: "deferred", note: "Waiting on Facebook account recovery" },
  { id: "anthropic", name: "Claude (Anthropic API)", domain: "documents", segments: ALL, access: "public_api", historicalImportYears: 0, webhooks: false, settings: ["ANTHROPIC_API_KEY"], status: "planned", note: "Reasoning, not a data source" },

  // Jewelry point of sale
  { id: "the_edge", name: "The Edge (Abbott Jewelry Systems)", domain: "pos", segments: ["retail"], access: "partner", historicalImportYears: 5, webhooks: false, settings: [], status: "planned", note: "No public API; partners use an on-premises connector. Start with scheduled exports" },
  { id: "jewel360", name: "Jewel360", domain: "pos", segments: ["retail"], access: "partner", historicalImportYears: 5, webhooks: false, settings: [], status: "planned", note: "Partner integrations only. Start with exports" },
  { id: "arms", name: "ARMS", domain: "pos", segments: ["retail"], access: "unknown", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "lightspeed", name: "Lightspeed Retail", domain: "pos", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "square", name: "Square", domain: "pos", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "clover", name: "Clover", domain: "pos", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "valigara", name: "Valigara", domain: "ecommerce", segments: ALL, access: "unknown", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },

  // E-commerce
  { id: "woocommerce", name: "WooCommerce", domain: "ecommerce", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "bigcommerce", name: "BigCommerce", domain: "ecommerce", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "wix", name: "Wix", domain: "ecommerce", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "punchmark", name: "Punchmark", domain: "ecommerce", segments: ["retail"], access: "partner", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },

  // Diamond and gem trading networks
  { id: "rapnet", name: "RapNet and the Rapaport Price List", domain: "diamonds", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 0, webhooks: false, settings: [], status: "planned", note: "Price list needs an active subscription" },
  { id: "idex", name: "IDEX Online", domain: "diamonds", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 0, webhooks: false, settings: [], status: "planned" },
  { id: "nivoda", name: "Nivoda", domain: "diamonds", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 0, webhooks: false, settings: [], status: "planned", note: "GraphQL; holds and orders need the Pro API" },
  { id: "vdb", name: "VDB (Virtual Diamond Boutique)", domain: "diamonds", segments: ["retail", "wholesale"], access: "partner", historicalImportYears: 0, webhooks: false, settings: [], status: "planned" },
  { id: "polygon", name: "Polygon", domain: "diamonds", segments: ["retail", "wholesale"], access: "unknown", historicalImportYears: 0, webhooks: false, settings: [], status: "planned", note: "Includes Memo-Track" },

  // Suppliers and product networks
  { id: "stuller", name: "Stuller", domain: "suppliers", segments: ["retail", "manufacturing"], access: "public_api", historicalImportYears: 5, webhooks: false, settings: [], status: "planned", note: "Product, gem, order and invoice APIs" },
  { id: "gemfind", name: "GemFind JewelCloud", domain: "suppliers", segments: ALL, access: "partner", historicalImportYears: 0, webhooks: false, settings: [], status: "planned" },
  { id: "quality_gold", name: "Quality Gold", domain: "suppliers", segments: ["retail"], access: "unknown", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },

  // Grading, appraisal and repair pricing
  { id: "gia", name: "GIA Report Results", domain: "grading", segments: ALL, access: "public_api", historicalImportYears: 0, webhooks: false, settings: [], status: "planned", note: "Needs a GIA lab account" },
  { id: "igi", name: "IGI report verification", domain: "grading", segments: ["retail", "wholesale"], access: "unknown", historicalImportYears: 0, webhooks: false, settings: [], status: "planned", note: "Web lookup only; no API found" },
  { id: "gellers_blue_book", name: "Geller's Blue Book", domain: "pricing", segments: ["retail"], access: "partner", historicalImportYears: 0, webhooks: false, settings: [], status: "planned", note: "Repair pricing; reached through the POS today" },
  { id: "gemguide_appraisal", name: "GemGuide Appraisal Software", domain: "grading", segments: ["retail"], access: "unknown", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },

  // Metal prices
  { id: "nfusion", name: "nFusion Solutions metals feed", domain: "pricing", segments: ALL, access: "public_api", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "metals_api", name: "Metals-API", domain: "pricing", segments: ALL, access: "public_api", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },

  // Clienteling, reviews and marketing
  { id: "clientbook", name: "Clientbook", domain: "crm", segments: ["retail"], access: "partner", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "podium", name: "Podium", domain: "communication", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "birdeye", name: "Birdeye", domain: "crm", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "klaviyo", name: "Klaviyo", domain: "marketing", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "attentive", name: "Attentive", domain: "marketing", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "twilio", name: "Twilio", domain: "communication", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },

  // Accounting, payments, financing and credit
  { id: "quickbooks", name: "QuickBooks Online", domain: "financial", segments: ALL, access: "public_api", historicalImportYears: 6, webhooks: true, settings: [], status: "planned" },
  { id: "xero", name: "Xero", domain: "financial", segments: ALL, access: "public_api", historicalImportYears: 6, webhooks: true, settings: [], status: "planned" },
  { id: "plaid", name: "Plaid", domain: "financial", segments: ALL, access: "public_api", historicalImportYears: 2, webhooks: true, settings: [], status: "planned", note: "Bank feeds beyond Chase" },
  { id: "authorize_net", name: "Authorize.net", domain: "financial", segments: ["retail", "wholesale"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "affirm", name: "Affirm", domain: "financial", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "synchrony", name: "Synchrony", domain: "financial", segments: ["retail"], access: "partner", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "acima", name: "Acima", domain: "financial", segments: ["retail"], access: "partner", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "jbt", name: "Jewelers Board of Trade", domain: "financial", segments: ["wholesale", "manufacturing"], access: "partner", historicalImportYears: 0, webhooks: false, settings: [], status: "planned", note: "Trade credit ratings" },

  // Manufacturing and wholesale ERP, EDI
  { id: "piro", name: "PIRO", domain: "erp", segments: ["wholesale", "manufacturing"], access: "edi", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "adaptive_erp", name: "Adaptive Jewelry ERP", domain: "erp", segments: ALL, access: "unknown", historicalImportYears: 5, webhooks: false, settings: [], status: "planned", note: "Built on Microsoft Dynamics NAV" },
  { id: "acumatica_jewelshop", name: "Acumatica JewelShop", domain: "erp", segments: ["wholesale", "manufacturing"], access: "public_api", historicalImportYears: 5, webhooks: true, settings: [], status: "planned" },
  { id: "diamtrade", name: "DiamTrade", domain: "erp", segments: ["wholesale", "manufacturing"], access: "unknown", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "edi_x12", name: "EDI with retail partners (X12 850, 855, 856, 810, 846, 852)", domain: "edi", segments: ["wholesale", "manufacturing"], access: "edi", historicalImportYears: 2, webhooks: false, settings: [], status: "planned", note: "Purchase orders, ship notices, invoices, inventory and sell-through" },

  // Insurance and secure shipping
  { id: "jewelers_mutual", name: "Jewelers Mutual care plans", domain: "insurance", segments: ["retail"], access: "public_api", historicalImportYears: 5, webhooks: false, settings: [], status: "planned" },
  { id: "parcel_pro", name: "Parcel Pro", domain: "shipping", segments: ALL, access: "partner", historicalImportYears: 2, webhooks: false, settings: [], status: "planned" },
  { id: "malca_amit", name: "Malca-Amit", domain: "shipping", segments: ["wholesale", "manufacturing"], access: "partner", historicalImportYears: 2, webhooks: false, settings: [], status: "planned" },
];

/** The integrations a given kind of business is likely to run. */
export function integrationsFor(segment: BusinessSegment): IntegrationSpec[] {
  return INTEGRATIONS.filter((integration) => integration.segments.includes(segment));
}
