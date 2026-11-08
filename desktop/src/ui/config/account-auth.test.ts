import { describe, expect, it } from "vitest";
import { accountCreation, accountModes, browserLinkLabel, usesBrowserSignIn } from "./account-auth";

describe("agent account authentication", () => {
  const mistralVibe = {
    signsInWithACode: true,
    tokenCommand: null,
    apiKeyVar: "MISTRAL_API_KEY",
  };

  it("offers subscription sign-in and API keys when both capabilities exist", () => {
    expect(accountModes(mistralVibe)).toEqual(["Subscription", "ApiKey"]);
  });

  it("keeps browser sign-in and API-key creation on separate request paths", () => {
    expect(usesBrowserSignIn(mistralVibe, "Subscription")).toBe(true);
    expect(accountCreation("MistralVibe", mistralVibe, "Subscription", "Work", ""))
      .toEqual({ kind: "MistralVibe", name: "Work", mode: "Subscription", secret: null });

    expect(usesBrowserSignIn(mistralVibe, "ApiKey")).toBe(false);
    expect(accountCreation("MistralVibe", mistralVibe, "ApiKey", "Work API", "key-value"))
      .toEqual({ kind: "MistralVibe", name: "Work API", mode: "ApiKey", secret: "key-value" });
  });

  it("labels a code-less browser link from the provider metadata", () => {
    expect(browserLinkLabel("Mistral Vibe")).toBe("Continue with Mistral Vibe");
    expect(browserLinkLabel("Cursor Agent")).toBe("Continue with Cursor");
  });
});
