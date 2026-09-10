import { useQuery } from "@tanstack/react-query";
import { http } from "./http";
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

export function useFallback(id: string) {
  return useQuery({ queryKey: ["account-fallback", id], queryFn: () => http<Fallback>(`/api/v1/sessions/${id}/fallback`), refetchInterval: 5000 });
}
export function saveFallback(id: string, value: Fallback) {
  return http<Fallback>(`/api/v1/sessions/${id}/fallback`, { method: "PUT", body: JSON.stringify(value) });
}
