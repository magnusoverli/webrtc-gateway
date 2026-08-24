import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ChannelViewer, initializeStandaloneRoute, StandalonePlayer } from "./StandalonePlayer";
import "./styles.css";

const route = initializeStandaloneRoute(window.location.pathname);
const content = route?.kind === "viewer"
  ? <ChannelViewer />
  : route?.kind === "embed"
    ? <StandalonePlayer channelID={route.channelID} />
    : <App />;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {content}
  </StrictMode>,
);
