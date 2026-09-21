/**
 * The refused-microphone dialog, on a platform that is not this one.
 *
 * This is the failure that cannot be seen from the machine it was written on.
 * The first version of the dialog said "macOS is blocking it", named a pane
 * that only exists on a Mac, and put a `x-apple.systempreferences:` link under
 * it — and on Windows the opener plugin refuses a scheme outside its scope
 * *silently*, so the button did nothing and said nothing while the words above
 * it described somebody else's computer.
 *
 * Nothing about that is visible from a Mac, where every word is true. So it is
 * asserted instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "~/platform";

/** The dialog as it renders on `where`, with the module graph rebuilt so that
    `platform.ts` reads the stubbed navigator rather than a cached answer. */
async function refusedOn(where: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgentData: { platform: where } });
  const { VoiceDialog } = await import("./Dialogs");
  return renderToStaticMarkup(
    <VoiceDialog blocked={{ why: "denied" }} onDismiss={() => {}} onConfigure={async () => {}} />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the microphone was refused", () => {
  it("names the system the person is actually on", async () => {
    expect(await refusedOn("macOS")).toContain("macOS is blocking it");

    const windows = await refusedOn("Windows");
    expect(windows).toContain("Windows is blocking it");
    expect(windows).not.toContain("macOS");
  });

  it("tells a Windows user about the switch that hides the app", async () => {
    // Two switches, and with the master one off the app is not in the per-app
    // list at all — which reads as Windows not knowing the app. Leaving this
    // step out is leaving the person at the point where they give up.
    expect(await refusedOn("Windows")).toContain("Let desktop apps access your microphone");
  });

  it("offers no button where there is nowhere honest to send anyone", async () => {
    const linux = await refusedOn("Linux");
    expect(linux).toContain("Not now");
    expect(linux).not.toContain("Open System Settings");
    expect(linux).not.toContain("Open Settings");
  });
});

describe("the deep links", () => {
  it("are all schemes the capability file permits", async () => {
    vi.resetModules();
    const { REFUSAL } = await import("./Dialogs");
    const capability = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../src-tauri/capabilities/default.json", import.meta.url)), "utf8"),
    ) as { permissions: ({ identifier: string; allow: { url: string }[] } | string)[] };

    const allowed = capability.permissions
      .filter((p): p is { identifier: string; allow: { url: string }[] } => typeof p === "object")
      .flatMap((p) => p.allow.map((a) => a.url.replace(/\*$/, "")));

    for (const [where, refusal] of Object.entries(REFUSAL) as [Platform, { deep: string | null }][]) {
      if (!refusal.deep) continue;
      expect(allowed.some((prefix) => refusal.deep!.startsWith(prefix)), `${where}: ${refusal.deep}`).toBe(true);
    }
  });
});
