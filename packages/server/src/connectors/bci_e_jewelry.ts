import { eJewelryConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["EJEWELRY_TENANT_ID", "EJEWELRY_ENVIRONMENT", "EJEWELRY_COMPANY_ID", "EJEWELRY_CLIENT_ID", "EJEWELRY_CLIENT_SECRET"]),
  make: async (env) =>
    eJewelryConnector({
      tenantId: setting(env, "EJEWELRY_TENANT_ID")!,
      environment: setting(env, "EJEWELRY_ENVIRONMENT")!,
      companyId: setting(env, "EJEWELRY_COMPANY_ID")!,
      clientId: setting(env, "EJEWELRY_CLIENT_ID")!,
      clientSecret: setting(env, "EJEWELRY_CLIENT_SECRET")!,
    }),
} satisfies ConnectorFactory;
