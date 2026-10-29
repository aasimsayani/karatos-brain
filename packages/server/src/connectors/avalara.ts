import { avalaraConnector, type AvalaraEnvironment } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["AVALARA_ACCOUNT_ID", "AVALARA_LICENSE_KEY", "AVALARA_ENVIRONMENT", "CUSTOMER_REF_KEY"]),
  make: async (env) => {
    const companyCode = setting(env, "AVALARA_COMPANY_CODE");
    return avalaraConnector({
      accountId: setting(env, "AVALARA_ACCOUNT_ID")!,
      licenseKey: setting(env, "AVALARA_LICENSE_KEY")!,
      environment: setting(env, "AVALARA_ENVIRONMENT") as AvalaraEnvironment,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      ...(companyCode ? { companyCode } : {}),
    });
  },
} satisfies ConnectorFactory;
