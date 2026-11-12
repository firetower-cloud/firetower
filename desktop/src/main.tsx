import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./platform";
/* Writes `data-theme` before the first frame. A frame of the wrong theme is
   the thing everybody notices and nobody can un-see. */
import "./theme";
import { App } from "./App";
import { Boundary } from "./ui/Boundary";
import { ConfirmProvider } from "./ui/Confirm";
import { catchExternalLinks } from "./open";
import { refuseStrayDrops } from "./ui/drop";
import { hydrate } from "./servers";

catchExternalLinks();
/* A file dropped anywhere but a conversation does nothing. Left to itself the
   webview navigates to it, and there is no browser chrome to come back with. */
refuseStrayDrops();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The last line of defence. A window with no browser chrome has nowhere
        to show an uncaught error but a black rectangle. */}
    <Boundary onReset={() => window.location.reload()}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </Boundary>
  </StrictMode>,
);

/* **The keychain is read after the first frame, not before it.** This was
   `await hydrate()` above the render, because the registry is read
   synchronously all over the app and a keychain is not — and that made a
   Secret Service read that does not answer into a window with nothing in it.
   Which is not hypothetical: a gnome-keyring that is installed but whose
   login keyring was never unlocked leaves the read pending behind an `Unlock
   Login Keyring` prompt, and a prompt that opens behind the window or is
   dismissed without being answered never resolves it. Photographed: two
   colours, against the harness's one for an empty window, for as long as the
   prompt was up — and that is the common Linux case.

   So the window draws its chrome first and `App` holds its body back until
   `tokensKnown()`, which `servers.ts` makes true either when the keychain has
   answered or when it has waited long enough. The read is never abandoned, so
   unlocking the keyring after that still signs you in. What it costs is that
   somebody can act while the read is in flight, which is what the eras in
   `servers.ts` are for. */
void hydrate();
