import { useEffect, useRef, useState } from "react";
import {
  absolutePath,
  channelHasFault,
  channelStateLabel,
  iframeEmbedCode,
  listenerPort,
  managementOrigin,
  mediaHost,
  resolveBinding,
  srtListenerURL,
  srtPublishURL,
  type Channel,
  type InputMode,
  type Track,
} from "./channel";
import { startSerialPolling } from "./polling";
import { useWHEPPlayer } from "./useWHEPPlayer";
import type { WHEPPlayerState } from "./useWHEPPlayer";
import { codecWarnings } from "./webrtc";

type GlobalSettings = {
  managementBindAddress: string;
  mediaBindAddress: string;
  logLevel: "error" | "warn" | "info" | "debug";
  readTimeout: string;
  writeTimeout: string;
  writeQueueSize: number;
  udpMaxPayloadSize: number;
  udpReadBufferSize: number;
  srtAddress: string;
  webRTCLocalUDPAddress: string;
  webRTCLocalTCPAddress: string;
  webRTCIPsFromInterfaces: boolean;
  webRTCAdditionalHosts: string[];
  webRTCHandshakeTimeout: string;
  webRTCTrackGatherTimeout: string;
  rtpPortMin: number;
  rtpPortMax: number;
  statisticsIntervalMs: number;
  defaultMaxReaders: number;
  applyState: "pending" | "applied" | "error";
  applyError?: string;
  updatedAt: string;
};

type NetworkInterface = {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  loopback: boolean;
};

type BindingStatus = {
  activeAddress?: string;
  desiredAddress: string;
  port?: number;
  restartRequired: boolean;
  locked?: boolean;
};

type Status = {
  gateway: { version: string; startedAt: string; restartRequired: boolean };
  media: { reachable: boolean; version?: string; started?: string; error?: string };
  settings: GlobalSettings;
  network: {
    interfaces: NetworkInterface[];
    management: BindingStatus;
    media: BindingStatus;
  };
  channels: Channel[];
};

type SettingsForm = Omit<GlobalSettings, "webRTCAdditionalHosts" | "applyState" | "applyError" | "updatedAt"> & {
  webRTCAdditionalHosts: string;
};

type ChannelForm = {
  name: string;
  enabled: boolean;
  automaticPreview: boolean;
  mode: InputMode;
  address: string;
  port: string;
  networkInterface: string;
  sourceIp: string;
  sdp: string;
  srtSdp: string;
  host: string;
  streamId: string;
  passphrase: string;
  hasPassphrase: boolean;
  clearPassphrase: boolean;
  latencyMs: string;
  maxReaders: string;
  useAbsoluteTimestamp: boolean;
};

const defaultSDP = (port: number) => `v=0
o=- 0 0 IN IP4 127.0.0.1
s=WebRTC Gateway RTP input
c=IN IP4 0.0.0.0
t=0 0
m=video ${port} RTP/AVP 96
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1`;

const emptyForm = (settings?: GlobalSettings, srtPort = 10000): ChannelForm => ({
  name: "",
  enabled: true,
  automaticPreview: true,
  mode: "srt-push",
  address: "0.0.0.0",
  port: String(srtPort),
  networkInterface: "",
  sourceIp: "",
  sdp: defaultSDP(settings?.rtpPortMin ?? 22000),
  srtSdp: "",
  host: "",
  streamId: "",
  passphrase: "",
  hasPassphrase: false,
  clearPassphrase: false,
  latencyMs: "60",
  maxReaders: String(settings?.defaultMaxReaders ?? 16),
  useAbsoluteTimestamp: true,
});

const formatBytes = (value: number) => {
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1);
  return `${(value / 1000 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [selectedID, setSelectedID] = useState("");
  const [statusError, setStatusError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [editingID, setEditingID] = useState<string | null>(null);
  const [form, setForm] = useState<ChannelForm | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [previewSaving, setPreviewSaving] = useState(false);
  const [previewSettingError, setPreviewSettingError] = useState("");
  const [revealedPassphrase, setRevealedPassphrase] = useState<string | null>(null);
  const [passphraseError, setPassphraseError] = useState("");
  const [revealingPassphrase, setRevealingPassphrase] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const passphraseRequestRef = useRef<AbortController | null>(null);

  const pollInterval = status?.settings.statisticsIntervalMs ?? 2000;

  useEffect(() => {
    let disposed = false;

    const load = async (signal: AbortSignal) => {
      try {
        const response = await fetch("/api/v1/status", { cache: "no-store", signal });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const nextStatus = (await response.json()) as Status;
        if (disposed) return;
        setStatus(nextStatus);
        setStatusError("");
        setSelectedID((current) =>
          nextStatus.channels.some((channel) => channel.id === current)
            ? current
            : nextStatus.channels[0]?.id ?? "",
        );
      } catch {
        if (!disposed && !signal.aborted) setStatusError("Gateway status is not responding");
      }
    };

    const stopPolling = startSerialPolling(load, pollInterval);
    return () => {
      disposed = true;
      stopPolling();
    };
  }, [pollInterval, refreshToken]);

  useEffect(() => setDeleteError(""), [selectedID]);

  const selected = status?.channels.find((item) => item.id === selectedID) ?? null;
  const selectedFault = Boolean(selected && channelHasFault(selected));
  const inputLive = Boolean(selected?.available && selected.online);
  const isLive = Boolean(selected?.outputReady);
  const preview = useWHEPPlayer({
    whepPath: selected?.whepPath ?? "",
    enabled: Boolean(selected?.automaticPreview && selected.outputReady),
    retry: true,
  });
  const compatibility = selected
    ? selected.compatibility.reasons.length
      ? selected.compatibility.reasons
      : selected.input.mode.startsWith("rtp-") ? codecWarnings(selected.tracks) : []
    : [];
  const selectedIsSRTPush = selected?.input.mode === "srt-push";
  const managementBinding = resolveBinding(
    status?.network.management.activeAddress,
    status?.network.management.desiredAddress ?? status?.settings.managementBindAddress ?? "*",
    status?.network.management.restartRequired ?? false,
    status?.settings.applyState ?? "pending",
  );
  const mediaBinding = resolveBinding(
    status?.network.media.activeAddress,
    status?.network.media.desiredAddress ?? status?.settings.mediaBindAddress ?? "*",
    false,
    status?.settings.applyState ?? "pending",
  );
  const selectedMediaHost = selectedIsSRTPush
    ? mediaHost(mediaBinding.address, window.location.hostname)
    : "";
  const selectedSRTURL = selectedIsSRTPush
    ? srtListenerURL(selected?.input.srt?.port, mediaBinding.address, window.location.hostname, selected?.input.srt?.latencyMs)
    : "";
  const selectedSRTAdvancedURL = selectedIsSRTPush && selected && !selected.input.srt?.sdp
    ? srtPublishURL(selected.path, status?.settings.srtAddress ?? "", mediaBinding.address, window.location.hostname)
    : "";
  const outputOrigin = managementOrigin(
    managementBinding.address,
    status?.network.management.port,
    window.location,
  );
  const pendingOutputOrigin = managementBinding.desiredAddress
    ? managementOrigin(managementBinding.desiredAddress, status?.network.management.port, window.location)
    : "";
  const viewerURL = selected ? absolutePath(outputOrigin, selected.viewerPath) : "";
  const pendingViewerURL = selected && pendingOutputOrigin ? absolutePath(pendingOutputOrigin, selected.viewerPath) : "";
  const embedURL = selected ? absolutePath(outputOrigin, selected.embedPath) : "";
  const whepURL = selected ? absolutePath(outputOrigin, selected.whepPath) : "";
  const iframeCode = selected ? iframeEmbedCode(embedURL, selected.name) : "";

  useEffect(() => {
    passphraseRequestRef.current?.abort();
    passphraseRequestRef.current = null;
    setRevealedPassphrase(null);
    setPassphraseError("");
    setRevealingPassphrase(false);
    setPreviewSettingError("");
    return () => {
      passphraseRequestRef.current?.abort();
      passphraseRequestRef.current = null;
    };
  }, [selectedID]);

  const openCreate = () => {
    setEditingID(null);
    setForm(emptyForm(status?.settings, nextSRTListenPort(status)));
    setFormError("");
  };

  const restartGateway = async () => {
    if (!status?.gateway.restartRequired || restarting) return;
    const desiredOrigin = managementOrigin(
      status.settings.managementBindAddress,
      status.network.management.port,
      window.location,
    );
    const destination = new URL("/", `${desiredOrigin}/`);
    setRestarting(true);
    setRestartError("");
    try {
      const response = await fetch("/api/v1/restart", { method: "POST" });
      const result = await response.json().catch(() => ({})) as { status?: string; error?: string };
      if (response.status !== 202) {
        throw new Error(result.error ?? `Request failed with ${response.status}`);
      }
      window.setTimeout(() => {
        if (destination.origin === window.location.origin && window.location.pathname === "/" && !window.location.search && !window.location.hash) {
          window.location.reload();
        } else {
          window.location.assign(destination.toString());
        }
      }, 1_000);
    } catch (error) {
      setRestartError(`${error instanceof Error ? error.message : "The restart request failed"}. Verify the Docker restart policy and try again.`);
      setRestarting(false);
    }
  };

  const openEdit = (item: Channel) => {
    const next = emptyForm(status?.settings, nextSRTListenPort(status));
    next.name = item.name;
    next.enabled = item.enabled;
    next.automaticPreview = item.automaticPreview;
    next.mode = item.input.mode;
    next.maxReaders = String(item.maxReaders);
    next.useAbsoluteTimestamp = item.useAbsoluteTimestamp;
    if (item.input.rtp) {
      next.address = item.input.rtp.address;
      next.port = String(item.input.rtp.port);
      next.networkInterface = item.input.rtp.interface ?? "";
      next.sourceIp = item.input.rtp.sourceIp ?? "";
      next.sdp = item.input.rtp.sdp;
    }
    if (item.input.srt) {
      next.host = item.input.srt.host ?? "";
      next.port = String(item.input.srt.port || 8890);
      next.streamId = item.input.srt.streamId ?? "";
      next.hasPassphrase = item.input.srt.hasPassphrase;
      next.latencyMs = String(item.input.srt.latencyMs || 60);
      next.srtSdp = item.input.srt.sdp ?? "";
    }
    setEditingID(item.id);
    setForm(next);
    setFormError("");
  };

  const openSettings = () => {
    if (!status) return;
    const { applyState: _applyState, applyError: _applyError, updatedAt: _updatedAt, ...editable } = status.settings;
    setSettingsForm({ ...editable, webRTCAdditionalHosts: status.settings.webRTCAdditionalHosts.join(", ") });
    setSettingsError("");
  };

  const saveSettings = async () => {
    if (!settingsForm) return;
    setSaving(true);
    setSettingsError("");
    try {
      const response = await fetch("/api/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...settingsForm,
          srtAddress: listenerAddress(settingsForm.mediaBindAddress, settingsForm.srtAddress, listenerPort(settingsForm.srtAddress)),
          webRTCLocalUDPAddress: listenerAddress(settingsForm.mediaBindAddress, settingsForm.webRTCLocalUDPAddress, listenerPort(settingsForm.webRTCLocalUDPAddress)),
          webRTCLocalTCPAddress: listenerAddress(settingsForm.mediaBindAddress, settingsForm.webRTCLocalTCPAddress, listenerPort(settingsForm.webRTCLocalTCPAddress), true),
          webRTCAdditionalHosts: settingsForm.webRTCAdditionalHosts.split(",").map((host) => host.trim()).filter(Boolean),
        }),
      });
      const result = (await response.json()) as GlobalSettings | { error: string };
      if (!response.ok) throw new Error("error" in result ? result.error : `Request failed with ${response.status}`);
      if ((result as GlobalSettings).applyState === "error") {
        const failed = result as GlobalSettings;
        setSettingsError(`Settings saved, but the media plane rejected them: ${failed.applyError ?? "apply failed"}`);
        setRefreshToken((current) => current + 1);
        return;
      }
      setSettingsForm(null);
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  };

  const updateAutomaticPreview = async (item: Channel, automaticPreview: boolean) => {
    setPreviewSaving(true);
    setPreviewSettingError("");
    setStatus((current) => current ? {
      ...current,
      channels: current.channels.map((channel) => channel.id === item.id ? { ...channel, automaticPreview } : channel),
    } : current);
    try {
      const response = await fetch(`/api/v1/channels/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(channelUpdatePayload(item, automaticPreview)),
      });
      const result = await response.json() as Channel | { error: string };
      if (!response.ok) throw new Error("error" in result ? result.error : `Request failed with ${response.status}`);
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setStatus((current) => current ? {
        ...current,
        channels: current.channels.map((channel) => channel.id === item.id ? { ...channel, automaticPreview: item.automaticPreview } : channel),
      } : current);
      setPreviewSettingError(error instanceof Error ? error.message : "Unable to update automatic preview");
    } finally {
      setPreviewSaving(false);
    }
  };

  const revealPassphrase = async (item: Channel) => {
    passphraseRequestRef.current?.abort();
    const abort = new AbortController();
    passphraseRequestRef.current = abort;
    setRevealingPassphrase(true);
    setPassphraseError("");
    try {
      const response = await fetch(`/api/v1/channels/${encodeURIComponent(item.id)}/srt-passphrase`, {
        cache: "no-store",
        signal: abort.signal,
      });
      const result = await response.json() as { configured?: boolean; passphrase?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? `Request failed with ${response.status}`);
      if (passphraseRequestRef.current !== abort) return;
      setRevealedPassphrase(result.configured ? result.passphrase ?? "" : null);
    } catch (error) {
      if (abort.signal.aborted || passphraseRequestRef.current !== abort) return;
      setPassphraseError(error instanceof Error ? error.message : "Unable to reveal passphrase");
    } finally {
      if (passphraseRequestRef.current === abort) {
        passphraseRequestRef.current = null;
        setRevealingPassphrase(false);
      }
    }
  };

  const saveChannel = async () => {
    if (!form) return;
    setSaving(true);
    setFormError("");
    try {
      const response = await fetch(
        editingID ? `/api/v1/channels/${encodeURIComponent(editingID)}` : "/api/v1/channels",
        {
          method: editingID ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(channelPayload(form)),
        },
      );
      const result = (await response.json()) as Channel | { error: string };
      if (!response.ok) {
        throw new Error("error" in result ? result.error : `Request failed with ${response.status}`);
      }
      const saved = result as Channel;
      setSelectedID(saved.id);
      setForm(null);
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to save channel");
    } finally {
      setSaving(false);
    }
  };

  const deleteChannel = async (item: Channel) => {
    if (!window.confirm(`Delete ${item.name}? Existing viewers will be disconnected.`)) return;
    setDeleteError("");
    try {
      const response = await fetch(`/api/v1/channels/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? `Unable to delete channel (${response.status})`);
      }
      if (response.status !== 202) {
        setSelectedID(status?.channels.find((channel) => channel.id !== item.id)?.id ?? "");
      }
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Unable to delete channel");
    }
  };

  const gatewaySettingsState = status?.settings.applyState === "error"
    ? "Error"
    : status?.gateway.restartRequired || status?.network.management.restartRequired
      ? "Restart required"
      : status?.settings.applyState === "pending"
        ? "Applying"
        : status ? "Applied" : "Loading";
  const workspaceTitle = selected?.name
    ?? (status === null
      ? statusError ? "Gateway unavailable" : "Loading Gateway"
      : status.channels.length === 0 ? "No channels configured" : "Selecting channel");

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">SD</span>
          <div>
            <strong>Signal Desk</strong>
            <small>WebRTC gateway</small>
          </div>
        </div>

        <section className="rail-group gateway-rail" aria-labelledby="gateway-rail-title">
          <div className="rail-heading">
            <span id="gateway-rail-title">Gateway</span>
          </div>
          <div className="service-state">
            <span className={status?.media.reachable ? "signal online" : status ? "signal fault" : "signal"} />
            <div>
              <strong>{status?.media.reachable ? "Media plane connected" : status ? "Media plane unavailable" : "Loading Gateway"}</strong>
              <small>{status?.media.version ? `MediaMTX ${status.media.version}` : "Shared service status"}</small>
            </div>
          </div>
          <button className="settings-nav" type="button" onClick={openSettings} disabled={!status}>
            <span>Global settings</span>
            <small>{gatewaySettingsState}</small>
          </button>
        </section>

        <section className="rail-group channels-rail" aria-labelledby="channels-rail-title">
          <div className="rail-heading">
            <span id="channels-rail-title">Channels</span>
            <button className="rail-add" type="button" onClick={openCreate} disabled={!status}>Add</button>
          </div>

          <nav className="channel-list" aria-label="Channels">
            {status?.channels.map((item) => {
              const live = item.outputReady;
              const state = channelStateLabel(item);
              const fault = channelHasFault(item);
              return (
                <button
                  className={item.id === selectedID ? "channel active" : "channel"}
                  key={item.id}
                  onClick={() => setSelectedID(item.id)}
                  type="button"
                >
                  <span className={live ? "signal online" : fault ? "signal fault" : "signal"} />
                  <span>{item.name}</span>
                  <small>{state}</small>
                </button>
              );
            })}
            {status === null && <div className="empty-rail">{statusError ? "Channels unavailable" : "Loading channels..."}</div>}
            {status !== null && status.channels.length === 0 && (
              <button className="empty-rail empty-action" type="button" onClick={openCreate}>Create the first channel</button>
            )}
          </nav>
        </section>
      </aside>

      <main className="workspace">
        <div className="gateway-notices" aria-label="Gateway notices">
          {statusError && <ScopedNotice scope="Gateway" message={`${statusError}. Gateway will retry automatically.`} />}
          {status?.settings.applyState === "error" && <ScopedNotice scope="Gateway" message={`Global settings saved but not applied: ${status.settings.applyError ?? "Media plane apply failed"}`} />}
          {(status?.network.management.restartRequired || status?.gateway.restartRequired) && (
            <div className="restart-banner">
              <div className="restart-banner-content">
                <div>
                  <span className="notice-scope">GATEWAY</span>
                  <p>
                    {status.network.management.restartRequired
                      ? <>Management interface change pending. Current Web UI, API, and WHEP signaling remain on {bindingLabel(status.network.management.activeAddress ?? "*", status.network.interfaces)} until restart, then move to {bindingLabel(status.network.management.desiredAddress, status.network.interfaces)}.</>
                      : <>A Gateway restart is required to apply pending changes.</>}
                  </p>
                </div>
                {status.gateway.restartRequired && (
                  <button className="button restart-button" type="button" disabled={restarting} onClick={() => void restartGateway()}>
                    {restarting ? "Restarting..." : "Restart Gateway"}
                  </button>
                )}
              </div>
              {restartError && <div className="restart-error" role="alert"><strong>Restart failed.</strong> {restartError}</div>}
            </div>
          )}
        </div>

        <header className="topbar">
          <div>
            <span className="eyebrow">{selected ? "CHANNEL" : "GATEWAY"}</span>
            <h1>{workspaceTitle}</h1>
          </div>
          <div className="topbar-actions">
            {selected && <button className="button secondary" type="button" disabled={selected.applyState === "deleting"} onClick={() => openEdit(selected)}>Configure channel</button>}
            {status && !selected && <button className="button secondary" type="button" onClick={status.channels.length ? undefined : openCreate} disabled={status.channels.length > 0}>Create channel</button>}
            <div className={isLive ? "state-pill live" : statusError && !status ? "state-pill fault" : "state-pill"}>
              <span className={isLive ? "signal online" : selectedFault || Boolean(statusError && !status) ? "signal fault" : "signal"} />
              {selected ? channelStateLabel(selected) : status === null ? statusError ? "Unavailable" : "Loading" : status.channels.length ? "Selecting" : "Empty"}
            </div>
          </div>
        </header>

        <div className="channel-notices" aria-label="Channel notices">
          {selected?.applyState === "error" && <ScopedNotice scope={`Channel · ${selected.name}`} message={`Configuration saved but not applied: ${selected.applyError ?? "Channel apply failed"}`} />}
          {selected?.applyState === "deleting" && <ScopedNotice scope={`Channel · ${selected.name}`} message="Deletion is pending and will be retried automatically." />}
          {selected && deleteError && <ScopedNotice scope={`Channel · ${selected.name}`} message={`Deletion failed: ${deleteError}`} />}
          {selected?.enabled && selected.applyState !== "deleting" && selected.relay && (selected.relay.state === "retrying" || selected.relay.state === "stopped") && <ScopedNotice scope={`Channel · ${selected.name}`} message={`SRT listener is unavailable: ${selected.relay.lastError ?? "the relay process stopped"}. Gateway will retry automatically.`} />}
          {selected && previewSettingError && <ScopedNotice scope={`Channel · ${selected.name}`} message={`Automatic preview was not updated: ${previewSettingError}`} />}
        </div>

        {selected ? (
          <>
            <section className="connection-grid" aria-label="Channel connections">
              <article className="panel connection-panel input-connection-panel">
                <div className="panel-heading connection-heading">
                  <div>
                    <span className="eyebrow">INPUT CONNECTION</span>
                    <h2>Encoder destination</h2>
                  </div>
                  <span className={selectedIsSRTPush ? "connection-badge" : "connection-badge muted"}>{selectedIsSRTPush ? "SRT PUSH" : "NOT APPLICABLE"}</span>
                </div>
                <BindingContext
                  state={mediaBinding.state}
                  activeLabel={bindingLabel(mediaBinding.address, status?.network.interfaces ?? [])}
                  scope="Gateway › Media interface"
                  error={status?.settings.applyError}
                />
                <div className="connection-rows">
                  <ConnectionRow label="SRT URL" value={selectedSRTURL || "-"} />
                  <ConnectionRow label="Destination IP" value={selectedMediaHost || "-"} />
                  <ConnectionRow label="Destination port" value={selectedIsSRTPush && selected.input.srt?.port ? String(selected.input.srt.port) : "-"} />
                  <ConnectionRow label="SRT mode" value={selectedIsSRTPush ? "Caller" : "-"} />
                  <PassphraseRow
                    applicable={selectedIsSRTPush}
                    configured={Boolean(selected.input.srt?.hasPassphrase)}
                    passphrase={revealedPassphrase}
                    loading={revealingPassphrase}
                    error={passphraseError}
                    onReveal={() => void revealPassphrase(selected)}
                    onHide={() => setRevealedPassphrase(null)}
                  />
                  <ConnectionRow label="MPEG-TS-only stream-ID URL" value={selectedSRTAdvancedURL || "-"} secondary />
                </div>
              </article>

              <article className="panel connection-panel output-connection-panel">
                <div className="panel-heading connection-heading">
                  <div>
                    <span className="eyebrow">OUTPUT CONNECTION</span>
                    <h2>Viewer delivery</h2>
                  </div>
                  <span className="connection-badge">ALWAYS AVAILABLE</span>
                </div>
                <BindingContext
                  state={managementBinding.state}
                  activeLabel={bindingLabel(managementBinding.address, status?.network.interfaces ?? [])}
                  desiredLabel={managementBinding.desiredAddress ? bindingLabel(managementBinding.desiredAddress, status?.network.interfaces ?? []) : undefined}
                  scope="Gateway › Web UI & API interface"
                />
                <div className="connection-rows">
                  <ConnectionRow label={managementBinding.state === "pending-restart" ? "Current viewer URL" : "Viewer URL"} value={viewerURL} openURL />
                  {pendingViewerURL && <ConnectionRow label="Viewer URL after restart" value={pendingViewerURL} secondary />}
                  <ConnectionRow label="Iframe embed code" value={iframeCode} />
                  <ConnectionRow label="WHEP API endpoint" value={whepURL} />
                </div>
              </article>
            </section>

            <section className="metric-strip" aria-label="Channel metrics">
              <Metric label="Input" value={formatBytes(selected.inboundBytes)} detail="received total" />
              <Metric label="Output" value={formatBytes(selected.outboundBytes)} detail="sent total" />
              <Metric label="Viewers" value={String(selected.readers.length)} detail="active readers" />
              <Metric label="Input errors" value={String(selected.inboundFramesInError)} detail="frames" warning={selected.inboundFramesInError > 0} />
            </section>

            <section className="content-grid">
              <article className="panel preview-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">WEBRTC PREVIEW</span>
                    <h2>{previewTitle(preview.state, selected.automaticPreview, isLive)}</h2>
                  </div>
                  <button
                    className={selected.automaticPreview ? "toggle active" : "toggle"}
                    type="button"
                    disabled={previewSaving || selected.applyState === "deleting"}
                    aria-label={selected.automaticPreview ? "Disable automatic preview" : "Enable automatic preview"}
                    aria-pressed={selected.automaticPreview}
                    onClick={() => void updateAutomaticPreview(selected, !selected.automaticPreview)}
                  ><span /></button>
                </div>
                <div className="preview-stage">
                  <video ref={preview.videoRef} autoPlay playsInline muted controls />
                  {!selected.automaticPreview && <div className="preview-message overlay-message">
                    <span className="preview-icon">OFF</span>
                    <strong>Automatic preview disabled for this channel</strong>
                    <p>Enable the persisted setting to create a dashboard WHEP reader when output is ready.</p>
                  </div>}
                  {selected.automaticPreview && !isLive && <div className={`preview-message overlay-message${channelHasFault(selected) ? " error-message" : ""}`}>
                    <span className="preview-icon">{channelHasFault(selected) ? "ERR" : inputLive ? "PREP" : "OFF"}</span>
                    <strong>{channelStateLabel(selected)}</strong>
                    <p>{previewOfflineDetail(selected)}</p>
                  </div>}
                  {selected.automaticPreview && isLive && preview.state === "connecting" && <div className="preview-message overlay-message"><span className="preview-icon pulse">ICE</span><strong>Establishing WHEP session</strong><p>Gathering LAN candidates and waiting for media.</p></div>}
                  {selected.automaticPreview && isLive && preview.state === "error" && <div className="preview-message overlay-message error-message"><span className="preview-icon">ERR</span><strong>Preview unavailable</strong><p>{preview.error} Retrying automatically.</p></div>}
                  {selected.automaticPreview && isLive && preview.state === "playing" && preview.hasAudio && !preview.hasVideo && <div className="preview-message audio-message"><span className="preview-icon">AUD</span><strong>Audio-only stream</strong><p>Audio is playing without a video track.</p></div>}
                </div>
                {preview.state !== "off" && <div className="preview-stat-grid">
                  <PreviewMetric label="Receive" value={formatBitrate(preview.stats?.bitrateBps ?? 0)} />
                  <PreviewMetric label="Codec" value={preview.stats?.codec ?? "gathering"} />
                  <PreviewMetric label="Video" value={preview.stats?.width ? `${preview.stats.width}×${preview.stats.height} · ${Math.round(preview.stats.framesPerSecond)} fps` : "waiting"} />
                  <PreviewMetric label="Network" value={`${preview.stats?.packetsLost ?? 0} lost · ${(preview.stats?.jitterMs ?? 0).toFixed(1)} ms jitter`} />
                  <PreviewMetric label="ICE path" value={preview.stats?.icePath ?? "gathering"} wide />
                  <PreviewMetric label="Frames" value={`${preview.stats?.framesDecoded ?? 0} decoded · ${preview.stats?.framesDropped ?? 0} dropped`} wide />
                </div>}
              </article>

              <article className="panel details-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">SIGNAL DETAIL</span>
                    <h2>Tracks</h2>
                  </div>
                  <span className="count">{selected.tracks.length}</span>
                </div>
                <div className="track-list">
                  {selected.tracks.map((track, index) => (
                    <div className="track" key={`${track.codec}-${index}`}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{track.codec}</strong>
                        <small>{formatTrack(track)}</small>
                      </div>
                    </div>
                  ))}
                  {!selected.tracks.length && <div className="empty-state">Track details appear when an input is online.</div>}
                </div>
                {selected.tracks.length > 0 && <div className={selected.compatibility.state === "error" ? "compatibility warning" : "compatibility compatible"}>
                  <span>{compatibilityTitle(selected)}</span>
                  {compatibility.map((message) => <p key={message}>{message}</p>)}
                  {selected.compatibility.state === "probing" && <p>Inspecting the incoming tracks and H264 frame structure.</p>}
                  {selected.compatibility.state === "starting" && selected.compatibility.worker.queued && <p>Waiting for compatibility worker capacity. Existing streams continue unaffected.</p>}
                  {selected.compatibility.state === "starting" && !selected.compatibility.worker.queued && <p>Starting an isolated H264/Opus compatibility output.</p>}
                  {selected.compatibility.state === "error" && <p>{selected.compatibility.lastError ?? "Compatibility output is unavailable."}</p>}
                  {selected.compatibility.state === "ready" && selected.compatibility.mode === "direct" && <p>Incoming tracks are routed directly without an FFmpeg worker.</p>}
                  {selected.compatibility.state === "ready" && selected.compatibility.mode === "transcoded" && <p>WebRTC output: {selected.outputTracks.map((track) => track.codec).join(" + ") || "H264 + Opus"}.</p>}
                </div>}
              </article>
            </section>

            <section className="channel-info">
              <InfoLine label="Input mode" value={inputModeLabel(selected.input.mode)} />
              <InfoLine label="Ingest path" value={selected.path} mono />
              <InfoLine label="WebRTC route" value={selected.compatibility.mode === "transcoded" ? "Automatic H264/Opus compatibility" : "Direct passthrough"} />
              <InfoLine label="WHEP signaling" value={whepURL} mono />
              <div className="danger-row">
                <button className="button danger" type="button" disabled={selected.applyState === "deleting"} onClick={() => void deleteChannel(selected)}>{selected.applyState === "deleting" ? "Deletion pending" : "Delete channel"}</button>
              </div>
            </section>
          </>
        ) : (
          <section className="blank-state">
            {status === null ? (
              statusError ? (
                <>
                  <span>STATUS UNAVAILABLE</span>
                  <h2>The Gateway did not respond.</h2>
                  <p>No channel or media-plane state is being assumed. Automatic polling will continue.</p>
                  <button className="button primary" type="button" onClick={() => setRefreshToken((current) => current + 1)}>Retry now</button>
                </>
              ) : (
                <>
                  <span>LOADING</span>
                  <h2>Reading Gateway state.</h2>
                  <p>Checking channels, shared bindings, and the media plane.</p>
                </>
              )
            ) : status.channels.length === 0 ? (
              <>
                <span>NO CHANNELS</span>
                <h2>{status.media.reachable ? "The media plane is ready." : "The Gateway has no channels."}</h2>
                <p>{status.media.reachable ? "Create an RTP or SRT channel to begin routing media." : "The channel list loaded successfully, but the shared media plane is unavailable."}</p>
                <button className="button primary" type="button" onClick={openCreate}>Create channel</button>
              </>
            ) : (
              <>
                <span>SELECTING CHANNEL</span>
                <h2>Opening the channel workspace.</h2>
              </>
            )}
          </section>
        )}
      </main>

      {form && (
        <ChannelEditor
          form={form}
          editing={editingID !== null}
          error={formError}
          saving={saving}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSave={() => void saveChannel()}
          rtpPortMin={status?.settings.rtpPortMin ?? 22000}
          srtPortDefault={nextSRTListenPort(status)}
          mediaBindingLabel={bindingLabel(mediaBinding.address, status?.network.interfaces ?? [])}
        />
      )}

      {settingsForm && status && (
        <SettingsEditor
          form={settingsForm}
          error={settingsError}
          saving={saving}
          onChange={setSettingsForm}
          onClose={() => setSettingsForm(null)}
          onSave={() => void saveSettings()}
          network={status.network}
          currentMediaBindAddress={status.network.media.activeAddress ?? status.settings.mediaBindAddress}
        />
      )}
    </div>
  );
}

function ChannelEditor({ form, editing, error, saving, rtpPortMin, srtPortDefault, mediaBindingLabel, onChange, onClose, onSave }: {
  form: ChannelForm;
  editing: boolean;
  error: string;
  saving: boolean;
  rtpPortMin: number;
  srtPortDefault: number;
  mediaBindingLabel: string;
  onChange: (form: ChannelForm) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const update = <K extends keyof ChannelForm>(key: K, value: ChannelForm[K]) => onChange({ ...form, [key]: value });
  const isRTP = form.mode === "rtp-unicast" || form.mode === "rtp-multicast";
  const isSRTPull = form.mode === "srt-pull";

  const switchMode = (mode: InputMode) => {
    const next = { ...form, mode };
    if (mode === "rtp-unicast" && (!next.address || next.address.startsWith("239."))) next.address = "0.0.0.0";
    if (mode === "rtp-multicast" && (!next.address || !next.address.startsWith("239."))) next.address = "239.0.0.1";
    if (mode === "srt-push" && form.mode !== mode) next.port = String(srtPortDefault);
    if (mode === "srt-pull" && form.mode !== mode) next.port = "8890";
    if (mode.startsWith("rtp-") && !isRTP) next.port = String(rtpPortMin);
    onChange(next);
  };

  return (
    <div className="editor-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="editor" role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <header className="editor-header">
          <div>
            <span className="eyebrow">CHANNEL CONFIGURATION</span>
            <h2 id="editor-title">{editing ? "Edit channel" : "New channel"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="editor-body">
          {error && <div className="alert editor-alert">{error}</div>}

          <div className="form-grid">
            <label className="field full">
              <span>Name</span>
              <input value={form.name} maxLength={80} onChange={(event) => update("name", event.target.value)} placeholder="Studio camera" />
            </label>

            <label className="field full">
              <span>Input mode</span>
              <select value={form.mode} onChange={(event) => switchMode(event.target.value as InputMode)}>
                <option value="srt-push">SRT push into gateway</option>
                <option value="srt-pull">SRT pull from source</option>
                <option value="rtp-unicast">RTP unicast</option>
                <option value="rtp-multicast">RTP multicast</option>
              </select>
            </label>

            {isRTP && (
              <>
                {form.mode === "rtp-multicast" ? (
                  <label className="field">
                    <span>Multicast group</span>
                    <input value={form.address} onChange={(event) => update("address", event.target.value)} />
                  </label>
                ) : (
                  <div className="inherited-binding">
                    <span>Listen interface</span>
                    <strong>{mediaBindingLabel}</strong>
                    <small>RTP unicast inherits the global media interface.</small>
                  </div>
                )}
                <label className="field">
                  <span>UDP port</span>
                  <input type="number" min="1" max="65535" value={form.port} onChange={(event) => update("port", event.target.value)} />
                </label>
                <label className="field">
                  <span>Source IP filter</span>
                  <input value={form.sourceIp} onChange={(event) => update("sourceIp", event.target.value)} placeholder="Optional" />
                </label>
                {form.mode === "rtp-multicast" && (
                  <label className="field">
                    <span>Network interface</span>
                    <input value={form.networkInterface} onChange={(event) => update("networkInterface", event.target.value)} placeholder="Optional, e.g. eth0" />
                  </label>
                )}
                <label className="field full">
                  <span>Session description (SDP)</span>
                  <textarea rows={9} value={form.sdp} onChange={(event) => update("sdp", event.target.value)} spellCheck={false} />
                  <small>Required because RTP payload types do not identify codecs by themselves.</small>
                </label>
              </>
            )}

            {isSRTPull && (
              <>
                <label className="field">
                  <span>Remote host</span>
                  <input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="192.168.1.50" />
                </label>
                <label className="field">
                  <span>Remote port</span>
                  <input type="number" min="1" max="65535" value={form.port} onChange={(event) => update("port", event.target.value)} />
                </label>
                <label className="field">
                  <span>Stream ID</span>
                  <input value={form.streamId} onChange={(event) => update("streamId", event.target.value)} placeholder="Optional" />
                </label>
              </>
            )}

            {form.mode === "srt-push" && (
              <label className="field full">
                <span>Sender destination UDP port</span>
                <input type="number" min="1024" max="65535" value={form.port} onChange={(event) => update("port", event.target.value)} />
                <small>The sender needs only this port and the gateway IP. No stream ID is required.</small>
              </label>
            )}

            {!isRTP && (
              <label className="field">
                <span>SRT latency</span>
                <div className="suffix-input"><input type="number" min="20" max="8000" value={form.latencyMs} onChange={(event) => update("latencyMs", event.target.value)} /><span>ms</span></div>
                <small>60 ms is tuned for reliable cabled LANs. Increase it for lossy or long-distance links.</small>
              </label>
            )}

            {!isRTP && (
			  <>
				<div className="field full">
				  <span>SRT passphrase</span>
				  <input type="password" value={form.passphrase} onChange={(event) => update("passphrase", event.target.value)} placeholder={form.hasPassphrase ? "Stored; leave blank to keep" : "Optional, 10-79 bytes"} />
				  {form.hasPassphrase && (
					<label className="check compact"><input type="checkbox" checked={form.clearPassphrase} onChange={(event) => update("clearPassphrase", event.target.checked)} />Clear stored passphrase</label>
				  )}
				</div>
				<label className="field full">
				  <span>Elementary RTP session description (SDP)</span>
				  <textarea rows={7} value={form.srtSdp} onChange={(event) => update("srtSdp", event.target.value)} spellCheck={false} placeholder="Optional; leave blank for automatic MPEG-TS or RTP/MP2T detection" />
				  <small>Only required when SRT carries elementary RTP with dynamic payload types. Raw MPEG-TS and RTP/MP2T payload type 33 are detected automatically.</small>
				</label>
			  </>
            )}

            <label className="field">
              <span>Maximum viewers</span>
              <input type="number" min="0" value={form.maxReaders} onChange={(event) => update("maxReaders", event.target.value)} />
              <small>Zero means unlimited.</small>
            </label>

            <div className="field option-stack">
              <label className="check"><input type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} />Channel enabled</label>
              <label className="check"><input type="checkbox" checked={form.automaticPreview} onChange={(event) => update("automaticPreview", event.target.checked)} />Automatic dashboard preview</label>
              <label className="check"><input type="checkbox" checked={form.useAbsoluteTimestamp} onChange={(event) => update("useAbsoluteTimestamp", event.target.checked)} />Preserve absolute timestamps</label>
            </div>
          </div>
        </div>

        <footer className="editor-footer">
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" disabled={saving} onClick={onSave}>{saving ? "Saving..." : editing ? "Save changes" : "Create channel"}</button>
        </footer>
      </section>
    </div>
  );
}

function SettingsEditor({ form, error, saving, network, currentMediaBindAddress, onChange, onClose, onSave }: {
  form: SettingsForm;
  error: string;
  saving: boolean;
  network: Status["network"];
  currentMediaBindAddress: string;
  onChange: (form: SettingsForm) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [sameInterface, setSameInterface] = useState(form.managementBindAddress === form.mediaBindAddress);
  const update = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => onChange({ ...form, [key]: value });
  const updateNumber = (key: keyof SettingsForm, value: string) => update(key, Number(value) as never);
  const updateListenerPort = (key: "srtAddress" | "webRTCLocalUDPAddress" | "webRTCLocalTCPAddress", port: string, disableWhenBlank = false) => {
    update(key, listenerAddress(form.mediaBindAddress, form[key], port, disableWhenBlank));
  };
  const managementRestartRequired = network.management.activeAddress === undefined
    ? network.management.restartRequired
    : network.management.activeAddress !== form.managementBindAddress;

  const changeManagementBinding = (managementBindAddress: string) => {
    onChange({
      ...form,
      managementBindAddress,
      ...(sameInterface ? { mediaBindAddress: managementBindAddress } : {}),
    });
  };

  const changeMediaBinding = (mediaBindAddress: string) => {
    if (sameInterface && mediaBindAddress !== form.managementBindAddress) setSameInterface(false);
    onChange({ ...form, mediaBindAddress });
  };

  return (
    <div className="editor-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="editor settings-editor" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="editor-header">
          <div>
            <span className="eyebrow">GATEWAY CONFIGURATION</span>
            <h2 id="settings-title">Global settings</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="editor-body">
          {error && <div className="alert editor-alert">{error}</div>}
          <div className="form-grid">
            <h3 className="settings-section">Control and media planes</h3>
            <p className="settings-section-note">These shared bindings determine where every channel is managed, ingested, and delivered.</p>
            <div className="binding-card">
              <div className="binding-card-heading">
                <span>CONTROL PLANE</span>
                {network.management.locked && <small>ENV LOCKED</small>}
              </div>
              <label className="field">
                <span>Web UI &amp; API interface</span>
                <select
                  value={form.managementBindAddress}
                  disabled={network.management.locked}
                  onChange={(event) => changeManagementBinding(event.target.value)}
                >
                  <BindingOptions value={form.managementBindAddress} interfaces={network.interfaces} />
                </select>
              </label>
              {network.management.locked ? (
                <p><code>GATEWAY_LISTEN_ADDR</code> owns this binding. Change the environment variable and restart the Gateway container.</p>
              ) : (
                <p>Management changes take effect only after the Gateway container restarts.</p>
              )}
              {managementRestartRequired && (
                <div className="binding-status restart">
                  <strong>Restart required</strong>
                  <span>Active: {network.management.activeAddress === undefined ? "Not reported" : bindingLabel(network.management.activeAddress, network.interfaces)}</span>
                  <span>Desired: {bindingLabel(form.managementBindAddress, network.interfaces)}</span>
                </div>
              )}
            </div>

            <div className="binding-card">
              <div className="binding-card-heading">
                <span>MEDIA PLANE</span>
                <small>LIVE APPLY</small>
              </div>
              <label className="field">
                <span>Media interface</span>
                <select value={form.mediaBindAddress} onChange={(event) => changeMediaBinding(event.target.value)}>
                  <BindingOptions
                    value={form.mediaBindAddress}
                    interfaces={network.interfaces}
                    includeCustom={currentMediaBindAddress === "custom"}
                  />
                </select>
              </label>
              <p>Applies immediately and briefly interrupts SRT, RTP, and WebRTC listeners and active channels.</p>
              {network.media.activeAddress && (
                <div className="binding-status">
                  <span>Active: {bindingLabel(network.media.activeAddress, network.interfaces)}</span>
                </div>
              )}
            </div>

            <label className="check binding-sync">
              <input
                type="checkbox"
                checked={sameInterface}
                onChange={(event) => {
                  setSameInterface(event.target.checked);
                  if (event.target.checked) onChange({ ...form, mediaBindAddress: form.managementBindAddress });
                }}
              />
              Use the same interface for management and media
            </label>

            <h3 className="settings-section">Dashboard and new channels</h3>
            <p className="settings-section-note">Dashboard polling changes immediately. Viewer defaults apply only when a new channel is created.</p>
            <label className="field">
              <span>Dashboard statistics interval</span>
              <div className="suffix-input"><input type="number" min="500" max="10000" value={form.statisticsIntervalMs} onChange={(event) => updateNumber("statisticsIntervalMs", event.target.value)} /><span>ms</span></div>
            </label>
            <label className="field">
              <span>New-channel maximum viewers</span>
              <input type="number" min="0" value={form.defaultMaxReaders} onChange={(event) => updateNumber("defaultMaxReaders", event.target.value)} />
              <small>Zero means unlimited.</small>
            </label>

            <h3 className="settings-section">Media plane runtime</h3>
            <p className="settings-section-note">Saving changes below live-applies the shared media service and can briefly interrupt active channels.</p>
            <label className="field">
              <span>Media server log level</span>
              <select value={form.logLevel} onChange={(event) => update("logLevel", event.target.value as GlobalSettings["logLevel"])}>
                <option value="error">Error</option>
                <option value="warn">Warning</option>
                <option value="info">Information</option>
                <option value="debug">Debug</option>
              </select>
            </label>
            <label className="field">
              <span>Media read timeout</span>
              <input value={form.readTimeout} onChange={(event) => update("readTimeout", event.target.value)} placeholder="5s" />
            </label>
            <label className="field">
              <span>Media write timeout</span>
              <input value={form.writeTimeout} onChange={(event) => update("writeTimeout", event.target.value)} placeholder="5s" />
            </label>
            <label className="field">
              <span>Media write queue size</span>
              <input type="number" min="1" value={form.writeQueueSize} onChange={(event) => updateNumber("writeQueueSize", event.target.value)} />
              <small>Must be a power of two.</small>
            </label>

            <h3 className="settings-section">Media plane · UDP transport</h3>
            <label className="field">
              <span>Maximum payload size</span>
              <div className="suffix-input"><input type="number" min="576" max="65507" value={form.udpMaxPayloadSize} onChange={(event) => updateNumber("udpMaxPayloadSize", event.target.value)} /><span>bytes</span></div>
            </label>
            <label className="field">
              <span>Receive buffer</span>
              <div className="suffix-input"><input type="number" min="0" max="1073741824" value={form.udpReadBufferSize} onChange={(event) => updateNumber("udpReadBufferSize", event.target.value)} /><span>bytes</span></div>
            </label>
            <label className="field">
              <span>RTP port start</span>
              <input type="number" min="1" max="65535" value={form.rtpPortMin} onChange={(event) => updateNumber("rtpPortMin", event.target.value)} />
            </label>
            <label className="field">
              <span>RTP port end</span>
              <input type="number" min="1" max="65535" value={form.rtpPortMax} onChange={(event) => updateNumber("rtpPortMax", event.target.value)} />
            </label>

            <h3 className="settings-section">Media plane · Shared listeners</h3>
            <label className="field">
              <span>Stream-ID SRT UDP port</span>
              <input type="number" min="1" max="65535" value={listenerPort(form.srtAddress)} onChange={(event) => updateListenerPort("srtAddress", event.target.value)} placeholder="8890" />
              <small>Direct listener for senders that use stream IDs.</small>
            </label>
            <label className="field">
              <span>WebRTC UDP port</span>
              <input type="number" min="1" max="65535" value={listenerPort(form.webRTCLocalUDPAddress)} onChange={(event) => updateListenerPort("webRTCLocalUDPAddress", event.target.value)} placeholder="8189" />
            </label>
            <label className="field">
              <span>WebRTC TCP fallback port</span>
              <input type="number" min="1" max="65535" value={listenerPort(form.webRTCLocalTCPAddress)} onChange={(event) => updateListenerPort("webRTCLocalTCPAddress", event.target.value, true)} placeholder="Blank disables" />
              <small>Leave blank to disable TCP fallback.</small>
            </label>

            {form.mediaBindAddress === "custom" && (
              <div className="legacy-addresses">
                <strong>Legacy custom addresses</strong>
                <p>These listeners use different legacy hosts. Selecting a unified Media interface exits legacy mode.</p>
                <div className="legacy-address-grid">
                  <label className="field full">
                    <span>MediaMTX SRT address</span>
                    <input value={form.srtAddress} onChange={(event) => update("srtAddress", event.target.value)} placeholder=":8890" />
                  </label>
                  <label className="field">
                    <span>WebRTC UDP address</span>
                    <input value={form.webRTCLocalUDPAddress} onChange={(event) => update("webRTCLocalUDPAddress", event.target.value)} placeholder=":8189" />
                  </label>
                  <label className="field">
                    <span>WebRTC TCP fallback</span>
                    <input value={form.webRTCLocalTCPAddress} onChange={(event) => update("webRTCLocalTCPAddress", event.target.value)} placeholder="Disabled" />
                  </label>
                </div>
              </div>
            )}

            <h3 className="settings-section">Media plane · WebRTC discovery</h3>
            <label className="field full">
              <span>Additional advertised hosts</span>
              <input value={form.webRTCAdditionalHosts} onChange={(event) => update("webRTCAdditionalHosts", event.target.value)} placeholder="192.168.1.10, gateway.local" />
              <small>Comma-separated LAN hostnames or IP addresses.</small>
            </label>
            <label className="check settings-check full"><input type="checkbox" checked={form.webRTCIPsFromInterfaces} onChange={(event) => update("webRTCIPsFromInterfaces", event.target.checked)} />Advertise addresses discovered from network interfaces</label>
            <label className="field">
              <span>Handshake timeout</span>
              <input value={form.webRTCHandshakeTimeout} onChange={(event) => update("webRTCHandshakeTimeout", event.target.value)} placeholder="10s" />
            </label>
            <label className="field">
              <span>Track gather timeout</span>
              <input value={form.webRTCTrackGatherTimeout} onChange={(event) => update("webRTCTrackGatherTimeout", event.target.value)} placeholder="2s" />
            </label>
          </div>
        </div>

        <footer className="editor-footer">
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" disabled={saving} onClick={onSave}>{saving ? "Saving..." : "Save settings"}</button>
        </footer>
      </section>
    </div>
  );
}

function BindingOptions({ value, interfaces, includeCustom = false }: {
  value: string;
  interfaces: NetworkInterface[];
  includeCustom?: boolean;
}) {
  const available = value === "*" || value === "custom" || interfaces.some((item) => item.address === value);
  return (
    <>
      <option value="*">All interfaces</option>
      {(includeCustom || value === "custom") && <option value="custom">Legacy custom addresses</option>}
      {interfaces.map((item) => <option key={item.address} value={item.address}>{interfaceLabel(item)}</option>)}
      {!available && <option value={value}>{value} (current, unavailable)</option>}
    </>
  );
}

function channelPayload(form: ChannelForm) {
  const common = {
    name: form.name,
    enabled: form.enabled,
    automaticPreview: form.automaticPreview,
    maxReaders: Number(form.maxReaders),
    useAbsoluteTimestamp: form.useAbsoluteTimestamp,
  };
  if (form.mode === "rtp-unicast" || form.mode === "rtp-multicast") {
    return {
      ...common,
      input: {
        mode: form.mode,
        rtp: {
          address: form.mode === "rtp-unicast" ? form.address || "0.0.0.0" : form.address,
          port: Number(form.port),
          interface: form.networkInterface,
          sourceIp: form.sourceIp,
          sdp: form.sdp,
        },
      },
    };
  }
  return {
    ...common,
    input: {
      mode: form.mode,
      srt: {
        host: form.mode === "srt-pull" ? form.host : "",
        port: Number(form.port),
        streamId: form.mode === "srt-pull" ? form.streamId : "",
        latencyMs: Number(form.latencyMs),
		sdp: form.srtSdp,
        ...(form.passphrase ? { passphrase: form.passphrase } : {}),
        clearPassphrase: form.clearPassphrase,
      },
    },
  };
}

function channelUpdatePayload(item: Channel, automaticPreview: boolean) {
  const common = {
    name: item.name,
    enabled: item.enabled,
    automaticPreview,
    maxReaders: item.maxReaders,
    useAbsoluteTimestamp: item.useAbsoluteTimestamp,
  };
  if (item.input.rtp) {
    return {
      ...common,
      input: {
        mode: item.input.mode,
        rtp: { ...item.input.rtp },
      },
    };
  }
  return {
    ...common,
    input: {
      mode: item.input.mode,
      srt: {
        host: item.input.srt?.host ?? "",
        port: item.input.srt?.port ?? 0,
        streamId: item.input.srt?.streamId ?? "",
        latencyMs: item.input.srt?.latencyMs ?? 0,
		sdp: item.input.srt?.sdp ?? "",
      },
    },
  };
}

function ScopedNotice({ scope, message }: { scope: string; message: string }) {
  return (
    <div className="alert scoped-notice" role="alert">
      <span className="notice-scope">{scope}</span>
      <p>{message}</p>
    </div>
  );
}

function BindingContext({ state, activeLabel, desiredLabel, scope, error }: {
  state: "active" | "pending-restart" | "unconfirmed";
  activeLabel: string;
  desiredLabel?: string;
  scope: string;
  error?: string;
}) {
  return (
    <div className={`binding-context ${state}`}>
      <span>{state === "unconfirmed" ? "CONFIGURED · NOT CONFIRMED" : "CURRENT"}</span>
      <p>{scope} · {activeLabel}</p>
      {state === "pending-restart" && desiredLabel && <small>After Gateway restart · {desiredLabel}</small>}
      {state === "unconfirmed" && <small>{error ? `Apply failed: ${error}` : "The shared media binding has not been confirmed active."}</small>}
    </div>
  );
}

function ConnectionRow({ label, value, secondary = false, openURL = false }: {
  label: string;
  value: string;
  secondary?: boolean;
  openURL?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`connection-row${secondary ? " secondary-row" : ""}`}>
      <label htmlFor={`connection-${label.replaceAll(" ", "-").toLowerCase()}`}>{label}</label>
      <div className="connection-value">
        <input
          id={`connection-${label.replaceAll(" ", "-").toLowerCase()}`}
          ref={inputRef}
          value={value}
          readOnly
          aria-label={`${label} value`}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="connection-actions">
          {openURL && value !== "-" && <a className="copy-action open-action" href={value} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>Open viewer</a>}
          <CopyButton label={label} value={value === "-" ? "" : value} input={inputRef} />
        </div>
      </div>
    </div>
  );
}

function PassphraseRow({ applicable, configured, passphrase, loading, error, onReveal, onHide }: {
  applicable: boolean;
  configured: boolean;
  passphrase: string | null;
  loading: boolean;
  error: string;
  onReveal: () => void;
  onHide: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const value = !applicable
    ? "-"
    : passphrase !== null
      ? passphrase
      : configured ? "Configured, hidden" : "Not configured";
  return (
    <div className="connection-row">
      <label htmlFor="connection-passphrase">Passphrase</label>
      <div className="connection-value">
        <input
          id="connection-passphrase"
          ref={inputRef}
          value={value}
          readOnly
          aria-label="Passphrase value"
          onFocus={(event) => passphrase !== null && event.currentTarget.select()}
        />
        <div className="connection-actions">
          {applicable && configured && passphrase === null && <button className="copy-action" type="button" disabled={loading} onClick={onReveal} aria-label="Reveal SRT passphrase">{loading ? "Revealing" : "Reveal"}</button>}
          {applicable && passphrase !== null && <CopyButton label="passphrase" value={passphrase} input={inputRef} />}
          {applicable && passphrase !== null && <button className="copy-action" type="button" onClick={onHide} aria-label="Hide SRT passphrase">Hide</button>}
          {(!applicable || !configured) && <CopyButton label="passphrase" value="" input={inputRef} />}
        </div>
      </div>
      {error && <small className="connection-error">{error}</small>}
    </div>
  );
}

function CopyButton({ label, value, input }: {
  label: string;
  value: string;
  input: { current: HTMLInputElement | null };
}) {
  const [feedback, setFeedback] = useState<"" | "Copied" | "Selected">("");

  useEffect(() => setFeedback(""), [value]);

  const copy = async () => {
    if (!value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setFeedback("Copied");
      return;
    } catch {
      input.current?.focus();
      input.current?.select();
      try {
        if (document.execCommand("copy")) {
          setFeedback("Copied");
          return;
        }
      } catch {
        // Keep the field selected for manual copying.
      }
      setFeedback("Selected");
    }
  };

  return <button className="copy-action" type="button" disabled={!value} onClick={() => void copy()} aria-label={`Copy ${label}`}>{feedback || "Copy"}</button>;
}

function Metric({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) {
  return (
    <div className={warning ? "metric warning" : "metric"}>
      <span>{label}</span><strong>{value}</strong><small>{detail}</small>
    </div>
  );
}

function PreviewMetric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? "preview-stat wide" : "preview-stat"}><span>{label}</span><strong>{value}</strong></div>;
}

function InfoLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-line"><span>{label}</span><code className={mono ? "" : "plain"}>{value}</code></div>
  );
}

function formatTrack(track: Track) {
  if (!track.codecProps) return "media track";
  const props = Object.entries(track.codecProps)
    .filter(([, value]) => value !== null && value !== "" && value !== 0)
    .map(([key, value]) => `${key} ${value}`);
  return props.join(" · ") || "media track";
}

function inputModeLabel(mode: InputMode) {
  return {
    "srt-push": "SRT push",
    "srt-pull": "SRT pull",
    "rtp-unicast": "RTP unicast",
    "rtp-multicast": "RTP multicast",
  }[mode];
}

function previewTitle(state: WHEPPlayerState, automatic: boolean, live: boolean) {
  if (!automatic) return "Automatic preview off";
  if (state === "connecting") return "Connecting preview";
  if (state === "playing") return "Live preview";
  if (state === "error") return "Preview error";
  return live ? "Starting preview" : "Input required";
}

function previewOfflineDetail(item: Channel) {
  if (item.applyState === "deleting") return "Channel cleanup is pending and will be retried automatically.";
  if (!item.enabled) return "This channel is disabled.";
  if (item.applyState === "error") return item.applyError ?? "The channel configuration could not be applied.";
  if (item.compatibility.state === "error") return item.compatibility.lastError ?? "A browser-compatible output is unavailable.";
  if (item.relay?.state === "retrying" || item.relay?.state === "stopped") return item.relay.lastError ?? "The SRT listener process is unavailable.";
  if (item.available && item.online) return "The encoder is connected and browser-compatible output is being prepared.";
  return "Preview starts automatically when output becomes ready.";
}

function compatibilityTitle(item: Channel) {
  if (item.compatibility.state === "error") return "COMPATIBILITY ERROR";
  if (item.compatibility.state === "probing") return "INSPECTING INPUT";
  if (item.compatibility.state === "starting") return item.compatibility.worker.queued ? "WAITING FOR CAPACITY" : "AUTOMATIC CONVERSION";
  if (item.compatibility.mode === "transcoded") return "AUTOMATICALLY NORMALIZED";
  return item.input.mode.startsWith("rtp-") && codecWarnings(item.tracks).length ? "CHECK PLAYBACK" : "DIRECT PLAYBACK";
}

function formatBitrate(bitsPerSecond: number) {
  if (bitsPerSecond < 1000) return `${Math.round(bitsPerSecond)} bps`;
  if (bitsPerSecond < 1_000_000) return `${(bitsPerSecond / 1000).toFixed(1)} kbps`;
  return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
}

function interfaceLabel(item: NetworkInterface) {
  return `${item.name} - ${item.address} (${item.family}${item.loopback ? ", loopback" : ""})`;
}

function bindingLabel(value: string, interfaces: NetworkInterface[]) {
  if (value === "*") return "All interfaces";
  if (value === "custom") return "Legacy custom addresses";
  const item = interfaces.find((candidate) => candidate.address === value);
  return item ? interfaceLabel(item) : `${value} (unavailable)`;
}

function listenerAddress(bindAddress: string, currentAddress: string, port: string, disableWhenBlank = false) {
  if (disableWhenBlank && !port) return "";
  if (bindAddress === "custom" && listenerPort(currentAddress) === port) return currentAddress;

  const currentHost = currentAddress.match(/^(.*):\d*$/)?.[1] ?? "";
  const host = bindAddress === "custom"
    ? currentHost
    : bindAddress === "*"
      ? ""
      : bindAddress.includes(":") ? `[${bindAddress.replace(/^\[|\]$/g, "")}]` : bindAddress;
  return `${host}:${port}`;
}

function nextSRTListenPort(status: Status | null) {
  const used = new Set<number>();
  if (status) {
    used.add(Number(status.settings.srtAddress.match(/:(\d+)$/)?.[1] ?? 0));
    used.add(Number(status.settings.webRTCLocalUDPAddress.match(/:(\d+)$/)?.[1] ?? 0));
    for (const item of status.channels) {
      if (item.input.rtp) used.add(item.input.rtp.port);
      if (item.input.mode === "srt-push" && item.input.srt?.port) used.add(item.input.srt.port);
    }
  }
  for (let port = 10000; port < 65536; port += 1) {
    const insideRTPRange = status && port >= status.settings.rtpPortMin && port <= status.settings.rtpPortMax;
    if (!insideRTPRange && !used.has(port)) return port;
  }
  return 10000;
}
