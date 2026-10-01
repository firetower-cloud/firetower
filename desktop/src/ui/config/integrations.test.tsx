/**
 * The connect row, asked what it offers once a client id is already registered.
 *
 * `configured` says a client id is stored, never that it still works — so an
 * application that was deleted, or that had the device flow switched off, leaves
 * a Connect button that cannot succeed. The regression: the field to correct one
 * was drawn only while `configured` was false, so after the first registration
 * there was no way to change it from this app at all, and disconnecting an
 * account does not clear it (it registers the application, not a person).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Integrations } from "./Integrations";
import { getListProvidersQueryKey } from "~/api/generated/providers/providers";
import { getListTrackersQueryKey } from "~/api/generated/trackers/trackers";
import type { ProviderStatus } from "~/api/generated/model";

const github = (p: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: "github",
  label: "GitHub",
  connected: false,
  configured: true,
  pending: null,
  clientId: "Ov23liREGISTERED",
  maySetApplication: true,
  ...p,
});

function draw(providers: ProviderStatus[]) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(getListProvidersQueryKey(), providers);
  cache.setQueryData(getListTrackersQueryKey(), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Integrations live />
    </QueryClientProvider>,
  );
}

describe("changing the application a git host is authorized against", () => {
  /** Exactly where somebody who disconnected to replace a token ends up. */
  it("is offered after a disconnect, beside Connect", () => {
    const html = draw([github({ connected: false })]);
    expect(html).toContain("Connect");
    expect(html).toContain(">application<");
  });

  /** Install-wide, so it is not something only a disconnected account may do. */
  it("is offered while connected too", () => {
    const html = draw([github({ connected: true })]);
    expect(html).toContain(">identity<");
    expect(html).toContain(">application<");
  });

  /** With none registered, the row still asks for one outright. */
  it("gives way to the first-run field when nothing is registered", () => {
    const html = draw([github({ configured: false, clientId: null })]);
    expect(html).toContain("OAuth client id");
    expect(html).not.toContain(">application<");
  });
});

/**
 * The application is one row with no owner, for the whole installation, so the
 * server takes it from an administrator and nobody else. This was drawn for
 * everybody: a member opened the field, typed a client id, and found out at
 * Save — which is the same mistake as a button the server will not honour.
 *
 * `maySetApplication` comes from the server rather than a role read here. If
 * the rule ever widens, nothing in this file has to be found and changed.
 */
describe("somebody the server will not take an application from", () => {
  it("is not offered the field when none is registered", () => {
    const html = draw([github({ configured: false, clientId: null, maySetApplication: false })]);
    expect(html).not.toContain("OAuth client id");
    expect(html).toContain("An administrator has to set this up");
  });

  it("is not offered the way to change one that is", () => {
    const html = draw([github({ connected: true, maySetApplication: false })]);
    // Their own account is still theirs to manage; only the install-wide
    // application is gone.
    expect(html).toContain(">identity<");
    expect(html).not.toContain(">application<");
  });

  it("can still connect their own account under it", () => {
    const html = draw([github({ connected: false, maySetApplication: false })]);
    expect(html).toContain("Connect");
    expect(html).not.toContain(">application<");
  });
});
