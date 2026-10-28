import { squareConnector } from "@karatos/connectors";
import { setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => [
    ...(setting(env, "CUSTOMER_REF_KEY") ? [] : ["CUSTOMER_REF_KEY"]),
    ...(setting(env, "SQUARE_ACCESS_TOKEN") || ["SQUARE_APPLICATION_ID", "SQUARE_APPLICATION_SECRET", "SQUARE_REFRESH_TOKEN"].every((name) => setting(env, name))
      ? []
      : ["SQUARE_APPLICATION_ID", "SQUARE_APPLICATION_SECRET", "SQUARE_REFRESH_TOKEN"]),
  ],
  make: async (env) => {
    const oauth = ["SQUARE_APPLICATION_ID", "SQUARE_APPLICATION_SECRET", "SQUARE_REFRESH_TOKEN"].every((name) => setting(env, name));
    // The OAuth connection is preferred: each refresh asks for the read scopes only.
    return squareConnector({
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      ...(setting(env, "SQUARE_ENVIRONMENT") ? { environment: setting(env, "SQUARE_ENVIRONMENT")! } : {}),
      ...(oauth
        ? { applicationId: setting(env, "SQUARE_APPLICATION_ID")!, applicationSecret: setting(env, "SQUARE_APPLICATION_SECRET")!, refreshToken: setting(env, "SQUARE_REFRESH_TOKEN")! }
        : { accessToken: setting(env, "SQUARE_ACCESS_TOKEN")! }),
    });
  },
} satisfies ConnectorFactory;
