import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Module melden ihre Befehle beim Befehlsregister an (je Menüregister ein Modul).
import "./module/start";
import "./module/seiten";
import "./module/konvertieren";
import "./module/kommentieren";
import "./module/schuetzen";
import { startEinrichten } from "./befehle/darstellung";

startEinrichten();
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
