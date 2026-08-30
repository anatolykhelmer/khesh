import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { LedgerProvider } from "./app/LedgerProvider";
import "./app/i18n";
import "./app/styles/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <LedgerProvider>
        <App />
      </LedgerProvider>
    </BrowserRouter>
  </StrictMode>,
);
