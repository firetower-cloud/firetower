/**
 * A server that is not finished being set up shows the setup and nothing else.
 *
 * The web build does the same with its `/setup` route and the
 * must-change-password refusal. Here the check is on every visit to a real
 * server, because a password that came from a file is a fact about the server.
 */
import { useGate } from "~/data";
import { usePathname } from "~/shims/next-navigation";
import { Setup } from "~/ui/Setup";
import { navigate } from "~/shims/next-navigation";

export function Gate({ children }: { children: React.ReactNode }) {
  const { setup, ready } = useGate();
  const path = usePathname();
  if (ready && setup && !path.startsWith("/account")) return <Setup onDone={() => navigate("/")} />;
  return <>{children}</>;
}
