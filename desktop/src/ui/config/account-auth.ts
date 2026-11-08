import type { AgentMode } from "~/api/generated/model";

/** Authentication capabilities the account dialog reads from `/agents`. */
export type AccountAuthCapabilities = {
  signsInWithACode: boolean;
  tokenCommand?: string | null;
  /** Environment variable used by the API-key credential, if supported. */
  apiKeyVar?: string | null;
};

/** Modes this agent can set up, in the order the dialog presents them. */
export function accountModes(agent: AccountAuthCapabilities): AgentMode[] {
  const modes: AgentMode[] = [];
  if (agent.signsInWithACode || agent.tokenCommand) modes.push("Subscription");
  if (agent.apiKeyVar) modes.push("ApiKey");
  return modes;
}

/** Whether a subscription account uses the worker-mediated browser flow. */
export function usesBrowserSignIn(
  agent: AccountAuthCapabilities,
  mode: AgentMode,
): boolean {
  return mode === "Subscription" && agent.signsInWithACode;
}

/** Use the API's provider label for the code-less browser link. */
export function browserLinkLabel(agentLabel: string): string {
  return `Continue with ${agentLabel.replace(/ Agent$/, "")}`;
}

/** Build the create request, keeping browser credentials out of the body. */
export function accountCreation<Kind extends string>(
  kind: Kind,
  agent: AccountAuthCapabilities,
  mode: AgentMode,
  name: string,
  secret: string,
) {
  return {
    kind,
    name,
    mode,
    secret: usesBrowserSignIn(agent, mode) ? null : secret,
  };
}
