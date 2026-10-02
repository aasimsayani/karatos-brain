import { loadEnv } from "./env.js";

// Confirms SUPABASE_URL and SUPABASE_ANON_KEY are accepted, and explains the usual failures.
const env = loadEnv();
const url = env.SUPABASE_URL;
const key = env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log("Supabase: NOT CONFIGURED. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.local.");
  process.exit(1);
}

const response = await fetch(new URL("/rest/v1/", url), { headers: { apikey: key, authorization: `Bearer ${key}` } }).catch(
  (error: Error) => {
    console.log(`Supabase: UNREACHABLE (${error.message}). Check SUPABASE_URL.`);
    process.exit(1);
  },
);

if (response.ok) {
  console.log("Supabase: OK");
  process.exit(0);
}
const hints: Record<number, string> = {
  401: "The key was rejected. Copy the anon (public) key again from Supabase > Project Settings > API, and make sure it belongs to the same project as SUPABASE_URL.",
  404: "Nothing at that address. SUPABASE_URL should look like https://<project-ref>.supabase.co with no path.",
};
console.log(`Supabase: FAILED with HTTP ${response.status}. ${hints[response.status] ?? ""}`.trim());
process.exit(1);
