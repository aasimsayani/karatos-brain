// Patterns for credentials that must never land in this public repo.
export const SECRET_PATTERNS = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /sk-(proj-)?[A-Za-z0-9]{32,}/],
  ["Stripe live key", /(sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["Shopify token", /shp(at|ca|pa|ss)_[A-Fa-f0-9]{32}/],
  ["Slack token", /xox[abpors]-[A-Za-z0-9-]{10,}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["HubSpot key", /pat-(na|eu)\d-[a-f0-9-]{36}/],
  ["JWT (e.g. Supabase key)", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Postgres URL with password", /postgres(ql)?:\/\/[^:\s/]+:(?!pass@|password@|postgres@|<|\[)[^@\s]{6,}@/],
];

/** Returns the labels of every secret pattern found in text. */
export function findSecrets(text) {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}
