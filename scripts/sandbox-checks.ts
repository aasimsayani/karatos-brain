import type { SandboxCheck } from "@karatos/core";

/**
 * Every built connector that has a vendor sandbox registers a check in its own
 * file, `scripts/sandbox-checks/<id>.ts`, and `npm run registry:write` lists
 * them in `scripts/sandbox-checks/index.ts` and passes their credentials to
 * the nightly job in .github/workflows/sandbox-run.yml. Credentials are
 * test-only sandbox values, named SANDBOX_<INTEGRATION>_<WHAT> and stored as
 * GitHub Actions secrets. Never point a check at a client's account.
 */
export { SANDBOX_CHECKS } from "./sandbox-checks/index.js";

/** Problems that would make the nightly run skip a check by mistake or touch a non-sandbox secret. */
export function credentialProblems(checks: readonly SandboxCheck[], workflow: string): string[] {
  const problems: string[] = [];
  for (const check of checks) {
    for (const name of check.credentials) {
      const prefix = `SANDBOX_${check.integration.toUpperCase()}_`;
      if (!name.startsWith(prefix) || !/^[A-Z0-9_]+$/.test(name)) {
        problems.push(`${check.integration}: credential ${name} must be named ${prefix}<WHAT>`);
      }
      if (!workflow.includes(`${name}: \${{ secrets.${name} }}`)) {
        problems.push(`${check.integration}: ${name} isn't passed to the job in sandbox-run.yml`);
      }
    }
  }
  return problems;
}
