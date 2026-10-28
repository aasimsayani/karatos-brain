import { describe, expect, it, vi } from "vitest";
import forms from "./custom_forms.js";

describe("the Custom forms sandbox check", () => {
  it("builds the Typeform connector from a test account's token and form, reading only that form", async () => {
    expect(forms.credentials).toEqual(["SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN", "SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID"]);
    const sent: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: String(init?.method), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ code: "stop_here", description: "stop" }), { status: 400 });
    });
    try {
      const connector = forms.connector({ SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN: "test-token", SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID: "TestForm1" });
      expect(connector.source).toBe("custom_forms");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://api.typeform.com/forms/TestForm1", method: "GET", auth: "Bearer test-token" }]);
  });;
});
