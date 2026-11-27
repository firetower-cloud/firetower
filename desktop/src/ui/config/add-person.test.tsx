/**
 * The password that is handed over once.
 *
 * **The server keeps a hash, so this screen is the only time it exists.** An
 * account whose password is lost between the answer arriving and somebody
 * reading it is an account an administrator has to reset, and the two ways to
 * lose it are both about what is on screen rather than about what was asked
 * for.
 *
 * The clipboard itself cannot be tested here — `navigator.clipboard` is
 * undefined on a non-secure origin, `document.execCommand` is the route that
 * actually runs there, and neither exists in node with no DOM. That was driven
 * on a real non-secure origin instead, and `AddPerson.tsx` records what it did.
 * What *is* testable, and is where the defect was, is the markup: whether the
 * password is in the document when it should not be, and whether the mask can
 * be selected as if it were the thing it hides.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HandOver } from "./AddPerson";
import { getSetupStateQueryKey } from "~/api/generated/setup/setup";
import type { SetupState } from "~/api/generated/model";

const PASSWORD = "wiry-garnet-04";

const setup = (publicUrl: string): SetupState => ({
  needsPassword: false,
  needsOrganization: false,
  needsGithub: false,
  completed: true,
  organization: { id: "o_1", name: "Acme" },
  publicUrl,
});

function draw({ publicUrl = "https://firetower.acme.co", fresh = true } = {}) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getSetupStateQueryKey(), setup(publicUrl));
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <HandOver handed={{ username: "marta", password: PASSWORD, fresh }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("what is on screen at rest", () => {
  /**
   * **Masked means absent, not merely covered.** The field renders one span or
   * the other rather than hiding one with CSS, so a password nobody has asked
   * to see is not sitting in the document for a screen reader, an extension or
   * a saved page to find.
   */
  it("does not put the password in the document until it is asked for", () => {
    expect(draw()).not.toContain(PASSWORD);
  });

  /**
   * **And the mask is not selectable.** Both spans carried `select-all`, so
   * dragging across a masked field put sixteen bullet characters on the
   * clipboard — the shape of a password, with nothing to say it was not one,
   * for the account whose real password is never shown again. The failure
   * sentence told you to do exactly that.
   */
  it("does not offer the mask to be selected as if it were the password", () => {
    const html = draw();
    expect(html).toContain("select-none");
    expect(html).not.toContain("select-all");
  });

  it("says it is shown once, where somebody decides whether to act on it", () => {
    expect(draw()).toContain("This password is shown once. The server keeps no readable copy.");
  });

  it("names the account it is for", () => {
    expect(draw()).toContain("marta is in");
    expect(draw({ fresh: false })).toContain("A new password for marta");
  });
});

/**
 * The note somebody pastes to a colleague.
 *
 * The password is hidden in it on screen and whole on the clipboard, so
 * reading over a shoulder gets nothing while the paste still works.
 */
describe("the note", () => {
  it("hides the password in what is drawn", () => {
    const html = draw();
    expect(html).toContain("Hi marta, you have an account on Firetower.");
    expect(html).not.toContain(`Password: ${PASSWORD}`);
    expect(html).toContain("Password: •");
  });

  it("sends them to the address the server gave, not to this window's", () => {
    expect(draw()).toContain("Sign in at https://firetower.acme.co");
  });

  /**
   * `publicUrl` is required on the wire and always arrives from a real server,
   * but the answer can still be in flight when this opens — and *Sign in at*
   * with nothing after it is a line somebody pastes to a colleague who then
   * cannot find the thing.
   */
  /**
   * **It used to promise a download that is not there.** The note said *"Once
   * you are signed in there, you can download the Mac or Windows app from the
   * same page"* — and since the application took the control plane's root,
   * that page is this one and carries no downloads. The colleague signed in,
   * landed in the product, and went looking for something nobody had moved.
   *
   * Asserted on the word rather than the sentence: whatever a future author
   * writes, a note that sends somebody to find a download is the defect.
   */
  it("promises no download, because there is none at that address", () => {
    const html = draw();
    expect(html).not.toMatch(/download/i);
    expect(html).not.toMatch(/same page/i);
  });

  it("drops the address line rather than leaving it dangling", () => {
    const html = draw({ publicUrl: "" });
    expect(html).not.toContain("Sign in at");
    expect(html).toContain("Username: marta");
  });
});
