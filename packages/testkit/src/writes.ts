import {
  InMemoryWriteAuditLog,
  READ_ONLY,
  WriteGate,
  WritesDisabledError,
  type Connector,
  type WriteAuditEntry,
} from "@karatos/core";
import { TEST_ORG } from "./harness.js";

/**
 * Runs every write action a connector declares through a read-only
 * WriteGate and checks each one is refused, audited and never performed.
 * Returns the audit entries. Throws if any write got through.
 */
export async function assertWritesRefused(connector: Connector): Promise<WriteAuditEntry[]> {
  const audit = new InMemoryWriteAuditLog();
  const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
  for (const action of connector.writes ?? []) {
    if (action.integration !== connector.source) {
      throw new Error(`write ${action.name} is declared for ${action.integration}, not ${connector.source}`);
    }
    let performed = false;
    const refused = await gate
      .run(action, "connector-testkit", async () => {
        performed = true;
      })
      .then(
        () => false,
        (error: unknown) => error instanceof WritesDisabledError,
      );
    if (performed || !refused) throw new Error(`write ${action.name} was not refused by a read-only gate`);
  }
  return audit.entries;
}
