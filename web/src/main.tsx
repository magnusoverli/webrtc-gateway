import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StandalonePlayer } from "./StandalonePlayer";
import "./styles.css";

const standalone = window.location.pathname.match(/^\/(view|embed)\/([^/]+)\/?$/);
const content = standalone
  ? <StandalonePlayer channelID={decodeURIComponent(standalone[2])} embed={standalone[1] === "embed"} />
  : <App />;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {content}
  </StrictMode>,
);
