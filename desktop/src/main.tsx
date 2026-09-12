import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { BackendProvider } from "./backend";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* One backend is "current" for anything that still reaches for a single
        API; the inbox reads across all of them explicitly. */}
    <BackendProvider id="e1">
      <App />
    </BackendProvider>
  </StrictMode>,
);
