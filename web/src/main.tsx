import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ChannelViewer, resolveStandaloneRoute, StandalonePlayer } from "./StandalonePlayer";
import "./styles.css";

const route = resolveStandaloneRoute(window.location.pathname, window.location.search);
const content = route?.kind === "viewer"
  ? <ChannelViewer initialChannelID={route.initialChannelID} />
  : route?.kind === "embed"
    ? <StandalonePlayer channelID={route.channelID} embed />
    : <App />;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {content}
  </StrictMode>,
);
