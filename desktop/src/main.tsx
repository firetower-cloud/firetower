import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./platform";
import { App } from "./App";
import { Boundary } from "./ui/Boundary";
import { ConfirmProvider } from "./ui/Confirm";
import { catchExternalLinks } from "./open";
import { hydrate } from "./servers";

catchExternalLinks();

/* Tokens come from the keychain, and the registry is read synchronously
   everywhere — so the keychain is read before the first render. */
await hydrate();

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
