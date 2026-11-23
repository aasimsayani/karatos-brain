import { redact } from "./instance-monitor.js";
import { parseVerifyArgs, renderVerification, requestVerification, verificationExitCode, VERIFY_CLI_USAGE, VerifyCliError } from "./verify-sync.js";

// npm run verify-sync -- --url <https://instance-host> --from YYYY-MM-DD --to YYYY-MM-DD [--system shopify] [--tolerance-cents 0] [--json]
// The key comes from INSTANCE_API_KEY. See docs/verify-sync.md.

const key = process.env.INSTANCE_API_KEY ?? "";
const say = (text: string) => process.stdout.write(redact(text, [key]));

async function main(): Promise<number> {
  const args = parseVerifyArgs(process.argv.slice(2));
  const report = await requestVerification(args, key);
  say(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderVerification(report));
  return verificationExitCode(report);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof VerifyCliError ? error.message : "the check couldn't run";
    process.stderr.write(redact(`verify-sync: ${message}\n\n${VERIFY_CLI_USAGE}\n`, [key]));
    process.exit(2);
  },
);
