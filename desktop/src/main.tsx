import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { Boundary } from "./ui/Boundary";
import { catchExternalLinks } from "./open";

catchExternalLinks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The last line of defence. A window with no browser chrome has nowhere
        to show an uncaught error but a black rectangle. */}
    <Boundary onReset={() => window.location.reload()}>
      <App />
    </Boundary>
  </StrictMode>,
);
