import { resolveSupplierProfiles, supplierInvoicesConnector, suppliersFromDirectory } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["SUPPLIER_INVOICES_IMPORT_DIR"]),
  make: async (env) => {
    const profileFor = await resolveSupplierProfiles(env.SUPPLIER_INVOICES_PROFILES);
    return supplierInvoicesConnector({ suppliers: await suppliersFromDirectory(setting(env, "SUPPLIER_INVOICES_IMPORT_DIR")!, profileFor) });
  },
} satisfies ConnectorFactory;
