import { test, expect } from "@playwright/test";
const origin = "http://preview.localhost:48080";

test("standalone selection, parent, persistence, safe HTML, stale targets and batched send", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    if (location.origin === "http://localhost:3000")
      localStorage.setItem("firetower.token", "test-only-annotation-token");
  });
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      if (
        event.data?.source === "firetower-panel" &&
        event.data?.type === "hello"
      ) {
        (window as unknown as { testChannel: string }).testChannel =
          event.data.channel;
      }
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let notes: Record<string, unknown>[] = [];
  const sent: unknown[] = [];
  await context.route(
    /http:\/\/localhost:(3000|4400)\/api\/v1\//,
    async (route) => {
      expect(route.request().headers().authorization).toBe(
        "Bearer test-only-annotation-token",
      );
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path.endsWith("/preview"))
        return route.fulfill({ json: { url: origin + "/", port: 8080 } });
      if (path.endsWith("/annotations/send")) {
        const payload = route.request().postDataJSON();
        sent.push(payload);
        notes = [];
        return route.fulfill({ json: { sent: true } });
      }
      if (path.endsWith("/annotations")) {
        if (method === "PUT") {
          const data = route.request().postDataJSON();
          const saved = {
            ...data,
            revision: data.revision + 1,
            delivery: "draft",
          };
          notes = notes.filter((n) => n.id !== saved.id).concat(saved);
          return route.fulfill({ json: saved });
        }
        if (method === "DELETE") {
          const ids = route
            .request()
            .postDataJSON()
            .notes.map((n: { id: string }) => n.id);
          notes = notes.filter((n) => !ids.includes(n.id));
          return route.fulfill({ json: true });
        }
        return route.fulfill({ json: notes });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto(origin + "/pricing");
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.getItem("firetower.token")),
  ).toBeNull();
  await page
    .getByRole("button", { name: "Firetower · Annotate", exact: true })
    .click();
  const panel = page.frameLocator(
    'iframe[title="Firetower preview annotations"]',
  );
  await expect(
    panel.getByRole("button", { name: "● Annotating · Browse", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  const channel = await page.evaluate(
    () => (window as unknown as { testChannel: string }).testChannel,
  );
  const trustedPanel = page
    .frames()
    .find((f) => f.url().includes("/preview-annotations?"))!;
  await trustedPanel.evaluate(
    ({ channel, origin }) => {
      const data = {
        source: "firetower-picker",
        channel,
        type: "selection",
        snapshot: {
          path: "/forged",
          selector: "#forged",
          ancestors: [],
          label: "Forged",
          html: "<div>Forged</div>",
          capturedAt: "2026-09-10",
          viewport: [100, 100],
          scroll: [0, 0],
          bounds: [0, 0, 10, 10],
          truncated: false,
        },
        parents: [],
      };
      window.dispatchEvent(
        new MessageEvent("message", { origin, source: window, data }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://wrong.example",
          source: window.parent,
          data,
        }),
      );
    },
    { channel, origin },
  );
  await expect(
    panel.getByRole("textbox", { name: "Annotation comment" }),
  ).toHaveCount(0);
  await page.locator("#choose").click();
  expect(
    await page.evaluate(
      () => (window as unknown as { activated?: boolean }).activated,
    ),
  ).toBeUndefined();
  await panel
    .getByRole("button", { name: "Select parent ↑", exact: true })
    .click();
  await expect(panel.getByText("article#pro", { exact: true })).toBeVisible();
  await panel
    .getByRole("textbox", { name: "Annotation comment" })
    .fill("Make the Pro card stand out");
  await panel.getByRole("button", { name: "Keep ↵", exact: true }).click();
  await expect(
    panel.getByText("Make the Pro card stand out", { exact: true }),
  ).toBeVisible();
  expect(JSON.stringify(notes)).not.toContain("never-capture-this");
  expect(JSON.stringify(notes)).toContain("[redacted]");
  expect(notes[0]).toMatchObject({
    port: 8080,
    snapshot: { path: "/pricing", selector: "#pro" },
  });
  await page.screenshot({ path: "test-results/preview-annotations-kept.png" });
  await page.reload();
  await page
    .getByRole("button", { name: "Firetower · Annotate", exact: true })
    .click();
  await expect(
    panel.getByText("Make the Pro card stand out", { exact: true }),
  ).toBeVisible();
  await page.locator("#pro").evaluate((el) => el.remove());
  await panel.getByRole("button", { name: "1. article#pro" }).click();
  await expect(
    panel.getByText(
      "Element changed or is on another page. The captured context is kept.",
    ),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Send 1 note to agent ↑" }).click();
  await expect(
    panel.getByText("Sent to agent. View the conversation for the response."),
  ).toBeVisible();
  expect(sent).toHaveLength(1);
  await page.screenshot({ path: "test-results/preview-annotations.png" });
});

test("refuses a bridge to a different preview origin", async ({
  page,
  context,
}) => {
  await context.route(/http:\/\/localhost:(3000|4400)\/api\/v1\//, (route) =>
    route.fulfill({ json: { url: "http://another-preview.localhost:4400/" } }),
  );
  await page.goto(
    "/preview-annotations?session=s_browser_test&port=8080&origin=" +
      encodeURIComponent(origin),
  );
  await expect(
    page.getByText("This preview does not belong", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Send/ })).toHaveCount(0);
});

test("a blocked embedded panel can annotate and send from a separate window", async ({
  page,
  context,
}) => {
  let kept: Record<string, unknown>[] = [];
  let sends = 0;
  await context.route(/http:\/\/localhost:(3000|4400)\/api\/v1\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview"))
      return route.fulfill({ json: { url: origin + "/", port: 8080 } });
    if (path.endsWith("/annotations/send")) {
      sends++;
      kept = [];
      return route.fulfill({ json: { sent: true } });
    }
    if (route.request().method() === "PUT") {
      const n = {
        ...route.request().postDataJSON(),
        revision: 1,
        delivery: "draft",
      };
      kept.push(n);
      return route.fulfill({ json: n });
    }
    return route.fulfill({ json: kept });
  });
  await page.goto(origin + "/strict");
  await page
    .getByRole("button", { name: "Firetower · Annotate", exact: true })
    .click();
  const popupReady = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Open feedback panel ↗", exact: true })
    .click();
  const popup = await popupReady;
  await expect(
    popup.getByRole("button", { name: "● Annotating · Browse", exact: true }),
  ).toBeEnabled();
  await page.locator("#choose").click();
  await popup
    .getByRole("textbox", { name: "Annotation comment" })
    .fill("Give the button more padding");
  await popup.getByRole("button", { name: "Keep ↵", exact: true }).click();
  await expect(
    popup.getByText("Give the button more padding", { exact: true }),
  ).toBeVisible();
  await popup.getByRole("button", { name: "Send 1 note to agent ↑" }).click();
  await expect(
    popup.getByText("Sent to agent. View the conversation for the response."),
  ).toBeVisible();
  expect(sends).toBe(1);
});
