/**
 * What stands between a connected server and the app proper.
 *
 * Two things, and they are answered in opposite places. A password the server
 * will not accept any work under is replaced in a browser, on the control
 * plane's own interface — so this draws a panel pointing there and nothing
 * else. A server that has not finished being set up shows the setup screen,
 * which this app does carry.
 *
 * Checked on every visit rather than at sign-in, because both are facts about
 * the server and both can become true under a running app: an administrator
 * can reset a password at any time, and the app would otherwise turn into a
 * wall of "could not reach the control plane" for a server answering perfectly.
 *
 * `/account` stays reachable while locked, because signing out and forgetting
 * the server live there and both are legitimate answers to being stuck.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useGate } from "~/data";
import { usePathname } from "~/shims/next-navigation";
import { Setup } from "~/ui/Setup";
import { ReplacePassword } from "~/ui/ReplacePassword";
import { navigate } from "~/shims/next-navigation";
import type { Backend } from "~/fleet";

export function Gate({ backend, children }: { backend: Backend; children: React.ReactNode }) {
  const cache = useQueryClient();
  const { setup, locked, ready } = useGate();
  const path = usePathname();

  if (ready && locked && !path.startsWith("/account")) {
    return (
      <ReplacePassword
        url={backend.url}
        username={backend.user}
        retryLabel="I've replaced it"
        // Everything, not the two keys this screen reads: being let in changes
        // the answer to every question the app has already asked and cached as
        // a refusal.
        onRetry={() => void cache.invalidateQueries()}
      />
    );
  }

  if (ready && setup && !path.startsWith("/account")) return <Setup onDone={() => navigate("/")} />;
  return <>{children}</>;
}
