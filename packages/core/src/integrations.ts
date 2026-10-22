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

/**
 * How a connector is tested without a client's real account:
 * - sandbox: the vendor offers a free developer, test or demo account
 * - fixtures: file or EDI formats, tested with synthetic sample files
 * - paid_account: needs a paid subscription or a trade account
 * - partner: needs a vendor partnership
 * - unknown: not confirmed yet
 */
export type IntegrationTesting = "sandbox" | "fixtures" | "paid_account" | "partner" | "unknown";

export interface IntegrationSpec {
  id: string;
  name: string;
  domain: IntegrationDomain;
  segments: BusinessSegment[];
  access: IntegrationAccess;
  testWith: IntegrationTesting;
  /**
   * Departments this system feeds, by department id (sales, repairs and so
   * on, plus the planned manufacturing and wholesale). Empty means every
   * department, for systems such as reasoning that are not a data source.
   */
  departments: string[];
  historicalImportYears: number;
  webhooks: boolean;
  /** Names in secrets/manifest.json this integration always needs. */
  settings: string[];
  /**
   * Ways to sign in, when a system offers more than one. The integration is
   * configured when `settings` and any one group are all set. The first
   * group is the one to ask a new client for.
   */
  signIn?: string[][];
  /**
   * The vendor's public API changelog or release notes, which the daily
   * vendor docs watch checks for changes. Null when none is published.
   */
  changelog: string | null;
  /** built: a connector exists and is tested; it is verified live on the first client account before sign-off. */
  status: "planned" | "built" | "deferred";
  note?: string;
  /**
   * What a business gets once this system is connected, one plain sentence
   * each, written for the owner. Required for every built connector; the
   * website shows them on the integration's card.
   */
  capabilities?: string[];
}

const ALL: BusinessSegment[] = ["retail", "wholesale", "manufacturing"];

export const INTEGRATIONS: IntegrationSpec[] = [
  // Brain A Integration Mapping sheet
  { id: "shopify", name: "Shopify", domain: "ecommerce", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["sales", "inventory", "clienteling", "marketing"], historicalImportYears: 5, webhooks: true, settings: ["SHOPIFY_SHOP_DOMAIN"], signIn: [["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"], ["SHOPIFY_ADMIN_ACCESS_TOKEN"]], changelog: "https://shopify.dev/changelog", status: "built", note: "Connector in @karatos/connectors: orders, refunds, fulfillments, products and customers, read-only",
    capabilities: [
      "Imports five years of orders, refunds and fulfillments, then keeps them current as orders change",
      "Sales sees every online and Shopify POS sale and return, with how it was paid",
      "Inventory sees every product and variant with its price and stock on hand",
      "Clienteling sees each customer and whether they agreed to email marketing",
      "Read-only: KaratOS never changes anything in your store",
    ] },
  { id: "inventory_pos", name: "Inventory and POS systems", domain: "ecommerce", segments: ["retail"], access: "file", testWith: "fixtures", departments: ["sales", "inventory", "clienteling", "marketing"], historicalImportYears: 5, webhooks: false, settings: ["POS_IMPORT_DIR"], changelog: null, status: "built", note: "CSV exports from any POS, read through a column-mapping profile", capabilities: [
      "Imports item lists, stock counts, customer lists and sales from any POS that exports CSV",
      "Reads each system's own column names through a mapping profile, with a generic profile built in",
      "Groups sale lines into receipts and turns negative lines into returns",
      "Picks up new and changed export files on every sync, without counting a row twice",
      "Read-only: KaratOS only reads the export files and never changes anything in your POS",
    ] },
  { id: "stripe", name: "Stripe", domain: "financial", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["sales", "finance", "clienteling"], historicalImportYears: 5, webhooks: true, settings: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], changelog: "https://docs.stripe.com/changelog", status: "built", note: "Connector in @karatos/connectors: charges, refunds, disputes, payouts, balance transactions and customers, read-only",
    capabilities: [
      "Imports five years of charges, refunds, disputes and payouts, then keeps them current from Stripe's events",
      "Finance sees every fee and payout, so card income can be matched to bank deposits",
      "Sales sees each payment's method and status, and every refund and dispute",
      "Read-only: KaratOS signs in with a restricted key that can't move money",
    ] },
  { id: "chase", name: "Chase business bank accounts and credit cards", domain: "financial", segments: ALL, access: "file", testWith: "fixtures", departments: ["finance", "compliance"], historicalImportYears: 6, webhooks: false, settings: ["CHASE_IMPORT_MODE", "CHASE_MANUAL_IMPORT_DIR"], changelog: null, status: "built", note: "CSV activity downloads, PDF statements or both, read with Chase's own layouts", capabilities: [
      "Imports six years of Chase business checking, savings and credit card activity from CSV downloads, PDF statements or both",
      "Reads Chase's own statement layout, including checks paid by number, deposits, card and electronic withdrawals, and fees",
      "Stores a transaction once even when a CSV download and a PDF statement both include it",
      "Sorts each transaction into cash deposits, card settlements, vendor payments, payroll and fees for finance",
      "Read-only: KaratOS only reads the statements you download and never connects to your Chase account",
    ] },
  { id: "bank_statements", name: "Bank and credit card statements (any bank)", domain: "financial", segments: ALL, access: "file", testWith: "fixtures", departments: ["finance", "compliance"], historicalImportYears: 6, webhooks: false, settings: ["BANK_STATEMENTS_IMPORT_DIR"], changelog: null, status: "built", note: "CSV exports and PDF statements from any bank", capabilities: [
      "Imports six years of bank and credit card transactions from any bank's CSV exports or PDF statements",
      "Sorts each transaction into cash deposits, card settlements, vendor payments, payroll and fees",
      "Stores a transaction once even when overlapping exports, or a CSV export and a PDF statement, both include it",
      "Lets finance check cash sales against cash deposits",
      "Read-only: KaratOS only reads the statements and never touches your accounts",
    ] },
  { id: "hubspot", name: "HubSpot", domain: "crm", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["clienteling", "sales", "marketing"], historicalImportYears: 5, webhooks: true, settings: ["HUBSPOT_ACCESS_TOKEN"], changelog: "https://developers.hubspot.com/changelog", status: "planned" },
  { id: "monday", name: "Monday.com", domain: "crm", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["repairs", "custom_orders", "sales"], historicalImportYears: 5, webhooks: true, settings: ["MONDAY_API_TOKEN"], changelog: "https://developer.monday.com/api-reference/changelog", status: "planned" },
  { id: "custom_forms", name: "Custom forms", domain: "crm", segments: ["retail"], access: "public_api", testWith: "fixtures", departments: ["clienteling", "repairs", "custom_orders"], historicalImportYears: 5, webhooks: true, settings: ["WEBHOOK_SIGNING_SECRET"], changelog: "https://www.typeform.com/developers/changelog/", status: "planned" },
  { id: "gmail", name: "Gmail", domain: "communication", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["clienteling", "buying", "custom_orders"], historicalImportYears: 5, webhooks: true, settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"], changelog: "https://developers.google.com/workspace/gmail/release-notes", status: "planned" },
  { id: "google_workspace", name: "Google Workspace and Drive", domain: "documents", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["finance", "compliance"], historicalImportYears: 5, webhooks: true, settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_DRIVE_ROOT_FOLDER_ID"], changelog: "https://developers.google.com/workspace/drive/release-notes", status: "planned" },
  { id: "slack", name: "Slack", domain: "communication", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["sales", "repairs", "custom_orders"], historicalImportYears: 5, webhooks: true, settings: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], changelog: "https://docs.slack.dev/changelog", status: "planned" },
  { id: "meta", name: "Instagram DMs, Facebook Messenger and WhatsApp Business", domain: "communication", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["clienteling", "marketing", "sales"], historicalImportYears: 5, webhooks: true, settings: ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"], changelog: "https://developers.facebook.com/docs/graph-api/changelog/versions", status: "deferred", note: "Waiting on Facebook account recovery" },
  { id: "anthropic", name: "Claude (Anthropic API)", domain: "documents", segments: ALL, access: "public_api", testWith: "paid_account", departments: [], historicalImportYears: 0, webhooks: false, settings: ["ANTHROPIC_API_KEY"], changelog: "https://platform.claude.com/docs/en/release-notes/overview", status: "planned", note: "Reasoning, not a data source" },

  // Jewelry point of sale
  { id: "the_edge", name: "The Edge (Abbott Jewelry Systems)", domain: "pos", segments: ["retail"], access: "partner", testWith: "partner", departments: ["sales", "inventory", "clienteling", "repairs"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "No public API; partners use an on-premises connector. Start with scheduled exports" },
  { id: "jewel360", name: "Jewel360", domain: "pos", segments: ["retail"], access: "partner", testWith: "partner", departments: ["sales", "inventory", "clienteling", "repairs"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "Partner integrations only. Start with exports" },
  { id: "arms", name: "ARMS", domain: "pos", segments: ["retail"], access: "unknown", testWith: "unknown", departments: ["sales", "inventory", "clienteling", "repairs"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "lightspeed", name: "Lightspeed Retail", domain: "pos", segments: ["retail"], access: "public_api", testWith: "unknown", departments: ["sales", "inventory", "clienteling", "repairs"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://x-series-api.lightspeedhq.com/changelog", status: "planned" },
  { id: "square", name: "Square", domain: "pos", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["sales", "inventory", "clienteling", "repairs"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://developer.squareup.com/docs/changelog/connect", status: "planned" },
  { id: "clover", name: "Clover", domain: "pos", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["sales", "inventory", "clienteling", "repairs"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://docs.clover.com/dev/changelog", status: "planned" },
  { id: "valigara", name: "Valigara", domain: "ecommerce", segments: ALL, access: "unknown", testWith: "unknown", departments: ["inventory", "sales", "marketing"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },

  // E-commerce
  { id: "woocommerce", name: "WooCommerce", domain: "ecommerce", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["sales", "inventory", "marketing"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://developer.woocommerce.com/changelog/", status: "planned" },
  { id: "bigcommerce", name: "BigCommerce", domain: "ecommerce", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["sales", "inventory", "marketing"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://docs.bigcommerce.com/developer/changelog", status: "planned" },
  { id: "wix", name: "Wix", domain: "ecommerce", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["sales", "inventory", "clienteling", "marketing"], historicalImportYears: 5, webhooks: true, settings: ["WIX_APP_ID", "WIX_APP_SECRET", "WIX_INSTANCE_ID", "WIX_WEBHOOK_PUBLIC_KEY", "CUSTOMER_REF_KEY"], changelog: "https://dev.wix.com/docs/changelog", status: "built", note: "A self-managed Wix app holding read permissions only; the connector checks the permissions the site granted and stops on any Manage permission, and sends only eight listed read requests. Webhooks need the app (an API key gets none). Sales, products and stock use the same events as Shopify, Square and Clover", capabilities: [
      "Imports five years of orders and the whole catalog, stock and contact list, then keeps them current",
      "Sales sees every Wix sale and refunded item with its SKUs, the same way as Shopify sales",
      "Inventory sees each product and variant with its price, and the stock Wix counts for it",
      "Works with both Wix Stores catalogs, the older V1 and the current V3",
      "Links a customer's orders and profile without keeping their name, email address, phone number or address",
      "Read-only: KaratOS checks its Wix app holds read permissions only and won't run otherwise",
    ] },
  { id: "punchmark", name: "Punchmark", domain: "ecommerce", segments: ["retail"], access: "partner", testWith: "partner", departments: ["sales", "inventory", "marketing"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },

  // Diamond and gem trading networks
  { id: "rapnet", name: "RapNet and the Rapaport Price List", domain: "diamonds", segments: ["retail", "wholesale"], access: "public_api", testWith: "paid_account", departments: ["buying", "inventory", "appraisals", "wholesale"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned", note: "Price list needs an active subscription" },
  { id: "idex", name: "IDEX Online", domain: "diamonds", segments: ["retail", "wholesale"], access: "public_api", testWith: "paid_account", departments: ["buying", "inventory", "appraisals", "wholesale"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "nivoda", name: "Nivoda", domain: "diamonds", segments: ["retail", "wholesale"], access: "public_api", testWith: "unknown", departments: ["buying", "inventory", "appraisals", "wholesale"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned", note: "GraphQL; holds and orders need the Pro API" },
  { id: "vdb", name: "VDB (Virtual Diamond Boutique)", domain: "diamonds", segments: ["retail", "wholesale"], access: "partner", testWith: "partner", departments: ["buying", "inventory", "appraisals", "wholesale"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "polygon", name: "Polygon", domain: "diamonds", segments: ["retail", "wholesale"], access: "unknown", testWith: "unknown", departments: ["buying", "inventory", "wholesale"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned", note: "Includes Memo-Track" },

  // Suppliers and product networks
  { id: "stuller", name: "Stuller", domain: "suppliers", segments: ["retail", "manufacturing"], access: "public_api", testWith: "paid_account", departments: ["buying", "custom_orders", "inventory", "repairs"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "Product, gem, order and invoice APIs" },
  { id: "gemfind", name: "GemFind JewelCloud", domain: "suppliers", segments: ALL, access: "partner", testWith: "partner", departments: ["buying", "inventory", "marketing", "wholesale"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "quality_gold", name: "Quality Gold", domain: "suppliers", segments: ["retail"], access: "unknown", testWith: "unknown", departments: ["buying", "custom_orders", "inventory"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },

  // Grading, appraisal and repair pricing
  { id: "gia", name: "GIA Report Results", domain: "grading", segments: ALL, access: "public_api", testWith: "paid_account", departments: ["appraisals", "inventory", "buying"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned", note: "Needs a GIA lab account" },
  { id: "igi", name: "IGI report verification", domain: "grading", segments: ["retail", "wholesale"], access: "unknown", testWith: "unknown", departments: ["appraisals", "inventory"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned", note: "Web lookup only; no API found" },
  { id: "gellers_blue_book", name: "Geller's Blue Book", domain: "pricing", segments: ["retail"], access: "partner", testWith: "partner", departments: ["repairs"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned", note: "Repair pricing; reached through the POS today" },
  { id: "gemguide_appraisal", name: "GemGuide Appraisal Software", domain: "grading", segments: ["retail"], access: "unknown", testWith: "unknown", departments: ["appraisals"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },

  // Metal prices
  { id: "nfusion", name: "nFusion Solutions metals feed", domain: "pricing", segments: ALL, access: "public_api", testWith: "paid_account", departments: ["metals", "buying"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "metals_api", name: "Metals-API", domain: "pricing", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["metals", "buying"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "No public API changelog; the nightly sandbox run catches API changes" },

  // Clienteling, reviews and marketing
  { id: "clientbook", name: "Clientbook", domain: "crm", segments: ["retail"], access: "partner", testWith: "partner", departments: ["clienteling", "sales"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "podium", name: "Podium", domain: "communication", segments: ["retail"], access: "public_api", testWith: "unknown", departments: ["clienteling", "marketing", "sales"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://docs.podium.com/changelog", status: "planned" },
  { id: "birdeye", name: "Birdeye", domain: "crm", segments: ["retail"], access: "public_api", testWith: "unknown", departments: ["marketing", "clienteling"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "klaviyo", name: "Klaviyo", domain: "marketing", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["marketing", "clienteling"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://developers.klaviyo.com/en/docs/changelog_", status: "planned" },
  { id: "attentive", name: "Attentive", domain: "marketing", segments: ["retail"], access: "public_api", testWith: "unknown", departments: ["marketing"], historicalImportYears: 5, webhooks: true, settings: [], changelog: null, status: "planned" },
  { id: "twilio", name: "Twilio", domain: "communication", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["clienteling", "repairs", "marketing"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://www.twilio.com/en-us/changelog", status: "planned" },

  // Accounting, payments, financing and credit
  { id: "quickbooks", name: "QuickBooks Online", domain: "financial", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["finance", "compliance"], historicalImportYears: 6, webhooks: true, settings: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REALM_ID", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_ENVIRONMENT"], changelog: null, status: "built", note: "Read-only, though Intuit has no read-only scope. Intuit's changelog (release notes) page needs JavaScript, so the docs watch reads the pages the mock was built from instead, and the nightly sandbox run catches API changes", capabilities: [
      "Imports six years of invoices, bills, payments and journal entries, with the chart of accounts, customers and vendors",
      "Keeps every change after that within the sync interval, and notices records deleted in QuickBooks",
      "Lines invoices up with the payments applied to them, so finance can see what's still owed",
      "Keeps customer and vendor names without their emails, phone numbers, addresses or tax IDs",
      "Read-only: KaratOS only reads your books, even though QuickBooks' connection would allow changes",
    ] },
  { id: "xero", name: "Xero", domain: "financial", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["finance", "compliance"], historicalImportYears: 6, webhooks: true, settings: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_TENANT_ID", "XERO_REFRESH_TOKEN"], changelog: "https://developer.xero.com/changelog", status: "built", note: "Read-only scopes only; the connector refuses a connection holding any other. The docs watch follows Xero's changelog, and the nightly run against the Demo Company catches API changes", capabilities: [
      "Imports six years of invoices, bills, credit notes, payments, bank transactions and manual journals, with the chart of accounts and contacts",
      "Keeps every change after that within the sync interval, including invoices and bills voided or deleted in Xero",
      "Lines invoices and bills up with the payments applied to them, so finance can see what's still owed",
      "Keeps contact names without their emails, phone numbers, addresses or tax numbers",
      "Read-only: the connection is granted read scopes only, and KaratOS stops if one could ever change your books",
    ] },
  { id: "plaid", name: "Plaid", domain: "financial", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["finance", "compliance"], historicalImportYears: 2, webhooks: true, settings: [], changelog: "https://plaid.com/docs/changelog/", status: "planned", note: "Bank feeds beyond Chase" },
  { id: "authorize_net", name: "Authorize.net", domain: "financial", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["sales", "finance"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://developer.authorize.net/api/changes/", status: "planned" },
  { id: "affirm", name: "Affirm", domain: "financial", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["sales", "finance"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://docs.affirm.com/developers/changelog", status: "planned" },
  { id: "synchrony", name: "Synchrony", domain: "financial", segments: ["retail"], access: "partner", testWith: "partner", departments: ["sales", "finance"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "acima", name: "Acima", domain: "financial", segments: ["retail"], access: "partner", testWith: "partner", departments: ["sales", "finance"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "jbt", name: "Jewelers Board of Trade", domain: "financial", segments: ["wholesale", "manufacturing"], access: "partner", testWith: "partner", departments: ["finance", "buying", "wholesale"], historicalImportYears: 0, webhooks: false, settings: [], changelog: null, status: "planned", note: "Trade credit ratings" },

  // Manufacturing and wholesale ERP, EDI
  { id: "piro", name: "PIRO", domain: "erp", segments: ["wholesale", "manufacturing"], access: "edi", testWith: "fixtures", departments: ["manufacturing", "inventory", "wholesale"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "adaptive_erp", name: "Adaptive Jewelry ERP", domain: "erp", segments: ALL, access: "unknown", testWith: "unknown", departments: ["inventory", "buying", "manufacturing", "wholesale"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "Built on Microsoft Dynamics NAV" },
  { id: "acumatica_jewelshop", name: "Acumatica JewelShop", domain: "erp", segments: ["wholesale", "manufacturing"], access: "public_api", testWith: "unknown", departments: ["inventory", "buying", "manufacturing", "wholesale"], historicalImportYears: 5, webhooks: true, settings: [], changelog: null, status: "planned" },
  { id: "diamtrade", name: "DiamTrade", domain: "erp", segments: ["wholesale", "manufacturing"], access: "unknown", testWith: "unknown", departments: ["inventory", "buying", "manufacturing", "wholesale"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "edi_x12", name: "EDI with retail partners (X12 850, 855, 856, 810, 846, 852)", domain: "edi", segments: ["wholesale", "manufacturing"], access: "edi", testWith: "fixtures", departments: ["inventory", "sales", "wholesale"], historicalImportYears: 2, webhooks: false, settings: [], changelog: null, status: "planned", note: "Purchase orders, ship notices, invoices, inventory and sell-through" },

  // Insurance and secure shipping
  { id: "jewelers_mutual", name: "Jewelers Mutual care plans", domain: "insurance", segments: ["retail"], access: "public_api", testWith: "partner", departments: ["sales", "repairs", "compliance"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "parcel_pro", name: "Parcel Pro", domain: "shipping", segments: ALL, access: "partner", testWith: "partner", departments: ["inventory", "repairs", "compliance"], historicalImportYears: 2, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "malca_amit", name: "Malca-Amit", domain: "shipping", segments: ["wholesale", "manufacturing"], access: "partner", testWith: "partner", departments: ["inventory", "repairs", "compliance"], historicalImportYears: 2, webhooks: false, settings: [], changelog: null, status: "planned" },
  // Systems other departments run: scheduling, tax and compliance, payroll, marketplaces, ads, CAD and refining
  { id: "calendly", name: "Calendly", domain: "crm", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["clienteling", "custom_orders", "repairs"], historicalImportYears: 2, webhooks: true, settings: [], changelog: "https://developer.calendly.com/release-notes", status: "planned", note: "Appointments for consultations, bridal and repair drop-off" },
  { id: "acuity", name: "Acuity Scheduling", domain: "crm", segments: ["retail"], access: "public_api", testWith: "paid_account", departments: ["clienteling", "custom_orders", "repairs"], historicalImportYears: 2, webhooks: true, settings: [], changelog: null, status: "planned" },
  { id: "avalara", name: "Avalara AvaTax", domain: "financial", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["compliance", "finance"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "Sales tax by jurisdiction. No public AvaTax changelog; the nightly sandbox run catches API changes" },
  { id: "taxjar", name: "TaxJar", domain: "financial", segments: ["retail", "wholesale"], access: "public_api", testWith: "unknown", departments: ["compliance", "finance"], historicalImportYears: 5, webhooks: false, settings: [], changelog: "https://developers.taxjar.com/api/reference/", status: "planned" },
  { id: "fincen_8300", name: "FinCEN Form 8300 cash reporting", domain: "financial", segments: ALL, access: "file", testWith: "fixtures", departments: ["compliance"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "Cash payments over $10,000; filed through BSA E-Filing, which has no API, so the brain prepares and tracks filings" },
  { id: "refiner_statements", name: "Refiner and scrap settlement statements", domain: "financial", segments: ALL, access: "file", testWith: "fixtures", departments: ["metals", "finance"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned", note: "CSV or PDF from the refiner" },
  { id: "gusto", name: "Gusto", domain: "financial", segments: ALL, access: "public_api", testWith: "sandbox", departments: ["finance", "compliance"], historicalImportYears: 3, webhooks: true, settings: [], changelog: "https://docs.gusto.com/app-integrations/changelog", status: "planned", note: "Payroll, commissions and staff costs" },
  { id: "mailchimp", name: "Mailchimp", domain: "marketing", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["marketing", "clienteling"], historicalImportYears: 5, webhooks: true, settings: [], changelog: "https://mailchimp.com/developer/release-notes/", status: "planned" },
  { id: "google_analytics", name: "Google Analytics 4", domain: "marketing", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["marketing", "sales"], historicalImportYears: 2, webhooks: false, settings: [], changelog: "https://developers.google.com/analytics/devguides/reporting/data/v1/changelog", status: "planned" },
  { id: "google_ads", name: "Google Ads", domain: "marketing", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["marketing"], historicalImportYears: 2, webhooks: false, settings: [], changelog: "https://developers.google.com/google-ads/api/docs/release-notes", status: "planned", note: "Test accounts for development; production needs an approved developer token" },
  { id: "meta_ads", name: "Meta Ads", domain: "marketing", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["marketing"], historicalImportYears: 2, webhooks: false, settings: [], changelog: "https://developers.facebook.com/docs/marketing-api/marketing-api-changelog", status: "planned" },
  { id: "google_business_profile", name: "Google Business Profile", domain: "marketing", segments: ["retail"], access: "partner", testWith: "partner", departments: ["marketing", "clienteling"], historicalImportYears: 2, webhooks: false, settings: [], changelog: null, status: "planned", note: "Reviews and local listings; Google approves API access on request" },
  { id: "etsy", name: "Etsy", domain: "ecommerce", segments: ["retail", "manufacturing"], access: "public_api", testWith: "unknown", departments: ["sales", "inventory", "marketing"], historicalImportYears: 5, webhooks: false, settings: [], changelog: null, status: "planned" },
  { id: "ebay", name: "eBay", domain: "ecommerce", segments: ["retail", "wholesale"], access: "public_api", testWith: "sandbox", departments: ["sales", "inventory"], historicalImportYears: 3, webhooks: true, settings: [], changelog: "https://developer.ebay.com/develop/api/trading-api/release-notes", status: "planned", note: "Estate and pre-owned pieces" },
  { id: "matrixgold", name: "MatrixGold CAD", domain: "erp", segments: ["retail", "manufacturing"], access: "unknown", testWith: "unknown", departments: ["custom_orders", "manufacturing"], historicalImportYears: 2, webhooks: false, settings: [], changelog: null, status: "planned", note: "Custom design files and metal weight estimates" },
  { id: "formlabs", name: "Formlabs 3D printing", domain: "erp", segments: ["retail", "manufacturing"], access: "unknown", testWith: "unknown", departments: ["custom_orders", "manufacturing"], historicalImportYears: 1, webhooks: false, settings: [], changelog: null, status: "planned", note: "Print jobs for wax and resin models" },
];

/**
 * Integrations we can build and test without asking any vendor for anything:
 * a public API with a free sandbox, or a file or EDI format we can test with
 * synthetic samples.
 */
export function selfServeIntegrations(): IntegrationSpec[] {
  return INTEGRATIONS.filter(
    (integration) =>
      integration.access !== "partner" && (integration.testWith === "sandbox" || integration.testWith === "fixtures"),
  );
}

/** The integrations a given kind of business is likely to run. */
export function integrationsFor(segment: BusinessSegment): IntegrationSpec[] {
  return INTEGRATIONS.filter((integration) => integration.segments.includes(segment));
}

/** How an instance stands with one catalog integration. Names settings, never their values. */
export interface IntegrationStatus {
  id: string;
  name: string;
  domain: IntegrationDomain;
  departments: string[];
  access: IntegrationAccess;
  catalogStatus: IntegrationSpec["status"];
  /** True when the integration needs settings and every one is set on this instance. */
  configured: boolean;
  /** Settings this instance still needs before the integration can connect. */
  missingSettings: string[];
}

/** Each catalog integration with whether this instance has its settings, for the console and onboarding. */
export function integrationStatuses(
  env: Readonly<Record<string, string | undefined>>,
  specs: readonly IntegrationSpec[] = INTEGRATIONS,
): IntegrationStatus[] {
  const missing = (names: readonly string[]) => names.filter((name) => !env[name]?.trim());
  return specs.map((spec) => {
    // With several ways to sign in, a complete one counts; otherwise ask for the first.
    const groups = spec.signIn ?? [];
    const signIn = groups.length === 0 ? [] : groups.some((g) => missing(g).length === 0) ? [] : missing(groups[0]!);
    const missingSettings = [...missing(spec.settings), ...signIn];
    return {
      id: spec.id,
      name: spec.name,
      domain: spec.domain,
      departments: spec.departments,
      access: spec.access,
      catalogStatus: spec.status,
      configured: spec.settings.length + groups.length > 0 && missingSettings.length === 0,
      missingSettings,
    };
  });
}
