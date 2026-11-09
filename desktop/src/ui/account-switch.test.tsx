/**
 * Leaving an account that has run out, while it is still holding the turn.
 *
 * The report was a workspace with nowhere to go: the notice named the account
 * that had hit its seven-day limit, offered another one, and the server
 * answered "stop the current turn before switching accounts" — or "answer the
 * pending approval or question" — for a turn that could not finish and a
 * question whose answer would spend the allowance that had just run out. The
 * client's half of that was a button it drew disabled whenever a turn was in
 * flight, which is the state a limit leaves a conversation in.
 *
 * Rendered against a seeded cache under the keys `useSessionAccount`,
 * `useAccounts` and `useAgents` store under, so what is on screen is what the
 * notice did with the answers it was handed — no network.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountNotice, AccountSwitcher } from "./AccountSwitcher";
import { accountsKey, sessionAccountKey } from "~/api/accounts";
import { getListAgentsQueryKey } from "~/api/generated/agents/agents";
import { getListHostsQueryKey } from "~/api/generated/hosts/hosts";
import type { Account, AgentView, Limit, Session, SessionAccount, Switch } from "~/api/generated/model";

const SESSION = { id: "s_01test", agent: "ClaudeCode", hostId: "h_01test", title: "A task" } as Session;

const account = (id: string, name: string, limits: Limit[] = []): Account =>
  ({ id, name, kind: "ClaudeCode", mode: "Subscription", enabled: true, state: "connected", credentialSet: true, isDefault: false, revision: 1, limits }) as Account;

/** What Claude Code reports when a window is spent rather than merely measured. */
const spent: Limit = { scope: "seven_day", status: "blocked", resetsAt: 1796486400 };

const claude = { kind: "ClaudeCode", label: "Claude Code", needsCredential: true, supported: true, enabled: true, credentialSet: true, signsInWithACode: false, hosts: [{ hostId: SESSION.hostId, installed: true }] } as AgentView;

function draw(switches: Switch[] = []) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  const state: SessionAccount = { account: account("personal", "Personal", [spent]), limits: [spent], switches };
  cache.setQueryData(sessionAccountKey(SESSION.id), state);
  cache.setQueryData(accountsKey, [account("personal", "Personal", [spent]), account("startup", "Startup plan")]);
  cache.setQueryData(getListAgentsQueryKey(), [claude]);
  cache.setQueryData(getListHostsQueryKey(), []);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <AccountSwitcher session={SESSION} working={true}>
        <AccountNotice />
      </AccountSwitcher>
    </QueryClientProvider>,
  );
}

describe("the notice above the composer when an account runs out", () => {
  it("says which account stopped and when it comes back", () => {
    const html = draw();
    expect(html).toContain("Personal");
    expect(html).toContain("seven_day");
    expect(html).toContain("The workspace is kept.");
  });

  /* The bug. A limit is hit *during* a turn, so `working` is exactly the state
     the only way out of the workspace has to be offered in. */
  it("offers the other account while the turn that ran out is still running", () => {
    const html = draw();
    expect(html).toContain("Continue with Startup plan");
    // The attribute, not the word: `disabled:bg-raise` is a Tailwind class and
    // is on the button either way.
    expect(html).not.toContain('disabled=""');
  });

  /* The control: `disabled` is something this render can see, so the
     assertion above is not passing because the attribute never appears. A
     switch already under way is the one thing that still takes the button
     away — pressing it again would be a second hand-off. */
  it("takes it away once a switch is actually under way", () => {
    const html = draw([{ toAccountId: "startup", state: "switching", afterLine: 0 }]);
    expect(html).toContain('disabled=""');
    expect(html).toContain("Account switch in progress…");
  });
});
