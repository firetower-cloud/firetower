import { useQuery } from "@tanstack/react-query";
import { http } from "~/client/http";
import type { Agent, AgentMode } from "./generated/model";

import type { Account, Limit, SessionAccount as AccountState, Fallback } from "./generated/model";
export type { Account, Limit, Fallback } from "./generated/model";
export type { SessionAccount as AccountState } from "./generated/model";

export const accountsKey = ["/api/v1/agent-accounts"];
export const sessionAccountKey = (id: string) => ["/api/v1/sessions", id, "account"];
export function useAccounts(poll = false) {
  return useQuery({ queryKey: accountsKey, queryFn: () => http<Account[]>(accountsKey[0]), refetchInterval: (query) => poll || query.state.data?.some((account) => account.state === "pending") ? 2500 : false });
}
export function useSessionAccount(id: string) {
  return useQuery({ queryKey: sessionAccountKey(id), queryFn: () => http<AccountState>(`/api/v1/sessions/${id}/account`), refetchInterval: 5000 });
}
export const createAccount = (data: { kind: Agent; name: string; mode: AgentMode; secret?: string }) =>
  http<Account>(accountsKey[0], { method: "POST", body: JSON.stringify(data) });
export const updateAccount = (id: string, data: { name?: string; isDefault?: boolean; enabled?: boolean; secret?: string }) =>
  http<Account>(`${accountsKey[0]}/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const switchAccount = (session: string, accountId: string, acceptPermissionChange = false) =>
  http<{ sessionId: string }>(`/api/v1/sessions/${session}/account`, { method: "POST", body: JSON.stringify({ accountId, acceptPermissionChange }) });

/** Exhaustion is explicit. Unknown statuses and temporary throttling are not exhaustion. */
export function exhausted(limit: Limit, now = Date.now() / 1000): boolean {
  return ["rejected", "blocked", "reached"].includes(limit.status) && (limit.resetsAt == null || limit.resetsAt > now);
}

/**
 * An account a session can run on: connected, still selectable, and holding
 * a credential that travels. A row without one is something that was started
 * and never finished, and nothing offers it.
 */
export function usable(account: Account): boolean {
  return account.enabled && account.state === "connected" && account.credentialSet;
}


/** `five_hour` → `5h`: the window, said the short way. */
function window(scope: string): string {
  return scope.replace(/^(five|5)_hour$/, "5h").replace(/^(seven|7)_day$/, "7d").replace(/_/g, " ");
}

/**
 * What is known of an account's allowance, in one line.
 *
 * A window that is fine says nothing: "5h: allowed" is a row of noise next
 * to the one number that matters. Percentages are shown when the provider
 * gives them; a status is shown only when it is not the good one.
 */
export function quota(account: Account): string {
  if (account.mode === "ApiKey") return "Metered API usage";
  if (account.limits.some((l) => exhausted(l))) return "Limit reached · try after reset";
  if (account.limits.length === 0) return "Connected · quota unknown";
  const said = account.limits
    .map((l) => (l.usedPercent != null ? `${window(l.scope)} ${l.usedPercent}%` : l.status === "allowed" ? "" : `${window(l.scope)} ${l.status}`))
    .filter(Boolean);
  return said.length ? said.join(" · ") : "Within limits";
}

export const fallbackKey = (id: string) => ["account-fallback", id];
export function useFallback(id: string) {
  return useQuery({ queryKey: fallbackKey(id), queryFn: () => http<Fallback>(`/api/v1/sessions/${id}/fallback`), refetchInterval: 5000 });
}
export function saveFallback(id: string, value: Fallback) {
  return http<Fallback>(`/api/v1/sessions/${id}/fallback`, { method: "PUT", body: JSON.stringify(value) });
}
