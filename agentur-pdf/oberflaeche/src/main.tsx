import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Module melden ihre Befehle beim Befehlsregister an (je Menüregister ein Modul).
import "./module/start";
import "./module/seiten";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
