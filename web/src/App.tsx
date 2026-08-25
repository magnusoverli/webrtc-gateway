import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  absolutePath,
  activeListenerHost,
  channelHasFault,
  channelPlaybackReady,
  channelStateLabel,
  hasInputStream,
  hasOutputStream,
  iframeEmbedCode,
  interfaceBindingSelector,
  listenerPort,
  managementOrigin,
  mediaHost,
  parseInterfaceBinding,
  resolveBinding,
  resolveInterfaceBinding,
  sampleChannelRates,
  srtListenerURL,
  srtPublishURL,
  trackKind,
  urlHost,
  type ChannelRateSample,
  type BindingInterface,
  type Channel,
  type InputMode,
  type Track,
} from "./channel";
import { startSerialPolling } from "./polling";
import { isRequestTimeoutError, requestJSON, requestText, type BoundedRequestInit } from "./request";
import { HelpTip, Tooltip } from "./Tooltip";
import { ChannelOverview, type OverviewFilter, type OverviewLayout } from "./ChannelOverview";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon } from "./Icons";
import { ModalShell } from "./Modal";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { formatBitrate, inputModeLabel } from "./presentation";
import { ToastProvider, useOptionalToast, useToast } from "./Toast";
import { readOverviewLayout, writeOverviewLayout } from "./uiPreferences";
import { useWHEPPlayer } from "./useWHEPPlayer";
import type { WHEPPlayerState } from "./useWHEPPlayer";
import { codecWarnings, type PreviewStats, type ReceiverStats, type VideoReceiverStats } from "./webrtc";

type GlobalSettings = {
  revision: number;
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

type NetworkInterface = BindingInterface;

type BindingStatus = {
  activeAddress?: string;
  activeSelection?: string;
  desiredAddress: string;
  resolvedAddress?: string;
  resolutionError?: string;
  port?: number;
  restartRequired: boolean;
  locked?: boolean;
  activeListeners?: {
    srt?: string;
    webRTCUDP?: string;
    webRTCTCP?: string;
  };
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
  resources?: ResourceSnapshot;
  channels: Channel[];
};

type ResourceStatus = "ok" | "warming" | "stale" | "unavailable";

type ResourceScope = {
  status: ResourceStatus;
  scope: string;
  errorCode?: string;
  sampledAt?: string;
  windowMs?: number;
  cpu: {
    percent: number | null;
    usedCores: number | null;
    capacityCores: number;
  };
  memory: {
    usedBytes: number;
    currentBytes?: number;
    totalBytes: number | null;
  };
};

type ResourceSnapshot = {
  sampledAt: string;
  gateway: ResourceScope;
  host: ResourceScope;
  media: { status: ResourceStatus; scope: string; errorCode?: string };
};

type SettingsForm = Omit<GlobalSettings, "revision" | "webRTCAdditionalHosts" | "applyState" | "applyError" | "updatedAt"> & {
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

type DashboardHistoryMode = "push" | "replace";

export function dashboardChannelID(search: string) {
  return new URLSearchParams(search).get("channel") ?? "";
}

export function dashboardURL(href: string, channelID = "") {
  const url = new URL(href);
  if (channelID) url.searchParams.set("channel", channelID);
  else url.searchParams.delete("channel");
  return `${url.pathname}${url.search}${url.hash}`;
}

function Dashboard() {
  const { showToast } = useToast();
  const initialChannelID = useRef(dashboardChannelID(window.location.search)).current;
  const [status, setStatus] = useState<Status | null>(null);
  const [selectedID, setSelectedID] = useState(initialChannelID);
  const [statusError, setStatusError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [editingID, setEditingID] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [form, setForm] = useState<ChannelForm | null>(null);
  const [formError, setFormError] = useState("");
  const [formConflict, setFormConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);
  const [settingsRevision, setSettingsRevision] = useState<number | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [settingsConflict, setSettingsConflict] = useState(false);
  const [previewSavingIDs, setPreviewSavingIDs] = useState<ReadonlySet<string>>(() => new Set());
  const [previewSettingError, setPreviewSettingError] = useState("");
  const [revealedPassphrase, setRevealedPassphrase] = useState<{ channelID: string; revision: number; value: string } | null>(null);
  const [passphraseError, setPassphraseError] = useState("");
  const [revealingPassphrase, setRevealingPassphrase] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [streamRates, setStreamRates] = useState<Record<string, { inputBitrateBps: number | null; outputBitrateBps: number | null; deliveryBitrateBps: number | null }>>({});
  const [view, setView] = useState<"overview" | "detail">(initialChannelID ? "detail" : "overview");
  const [overviewQuery, setOverviewQuery] = useState("");
  const [overviewFilter, setOverviewFilter] = useState<OverviewFilter>("all");
  const [overviewLayout, setOverviewLayout] = useState<OverviewLayout>(readOverviewLayout);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [diagnosticsTarget, setDiagnosticsTarget] = useState<
    { scope: "system" } | { scope: "channel"; channelID: string; channelName: string } | null
  >(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const passphraseRequestRef = useRef<AbortController | null>(null);
  const rateSamplesRef = useRef<ReadonlyMap<string, ChannelRateSample>>(new Map());
  const statusPollingRef = useRef<ReturnType<typeof startSerialPolling> | null>(null);
  const selectedRevisionRef = useRef<{ id: string; revision: number } | null>(null);
  const overviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingHeadingFocusRef = useRef<"overview" | "detail" | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const restoreDeleteFocusRef = useRef(false);
  const previousStatusErrorRef = useRef(false);
  const previousMediaReachableRef = useRef<boolean | null>(null);
  const previousPreviewAnnouncementRef = useRef("");

  const pollInterval = status?.settings.statisticsIntervalMs ?? 2000;

  useEffect(() => writeOverviewLayout(overviewLayout), [overviewLayout]);

  useEffect(() => {
    const synchronizeRoute = () => {
      const channelID = dashboardChannelID(window.location.search);
      const nextView = channelID ? "detail" : "overview";
      pendingHeadingFocusRef.current = nextView;
      setView(nextView);
      if (channelID) setSelectedID(channelID);
      setForm(null);
      setSettingsForm(null);
    };
    window.addEventListener("popstate", synchronizeRoute);
    return () => window.removeEventListener("popstate", synchronizeRoute);
  }, []);

  useEffect(() => {
    if (view !== "detail") return;
    if (!selectedID) {
      if (status) showOverview("replace");
      return;
    }
    if (dashboardChannelID(window.location.search) !== selectedID) {
      window.history.replaceState(null, "", dashboardURL(window.location.href, selectedID));
    }
  }, [selectedID, status, view]);

  useEffect(() => {
    let disposed = false;

    const load = async (signal: AbortSignal) => {
      try {
        const { response, body } = await requestJSON<unknown>("/api/v1/status", { cache: "no-store", signal });
        if (!response.ok) throw new APIRequestError(response.status, apiErrorMessage(body, response.status, "Gateway status request failed"));
        if (!isStatus(body)) throw new Error("Gateway returned malformed status data");
        const nextStatus = body;
        if (disposed) return;
        const sampledRates = sampleChannelRates(nextStatus.channels, rateSamplesRef.current, performance.now());
        rateSamplesRef.current = sampledRates.samples;
        setStreamRates(sampledRates.rates);
        setStatus(nextStatus);
        setStatusError("");
        setSelectedID((current) =>
          nextStatus.channels.some((channel) => channel.id === current)
            ? current
            : nextStatus.channels[0]?.id ?? "",
        );
      } catch (error) {
        if (!disposed && !signal.aborted) setStatusError(statusErrorMessage(error));
        throw error;
      }
    };

    const stopPolling = startSerialPolling(load, pollInterval);
    statusPollingRef.current = stopPolling;
    return () => {
      disposed = true;
      stopPolling();
      if (statusPollingRef.current === stopPolling) statusPollingRef.current = null;
    };
  }, [pollInterval, refreshToken]);

  useEffect(() => setDeleteError(""), [selectedID]);

  const selected = status?.channels.find((item) => item.id === selectedID) ?? null;
  selectedRevisionRef.current = selected ? { id: selected.id, revision: selected.revision } : null;
  const statusStale = Boolean(status && statusError);
  const selectedRates = selected ? streamRates[selected.id] : undefined;
  const selectedFault = Boolean(selected && channelHasFault(selected));
  const inputLive = Boolean(selected?.available && selected.online);
  const isLive = channelPlaybackReady(selected) && !selectedFault;
  const hasInput = Boolean(selected && hasInputStream(selected));
  const hasOutput = Boolean(selected && hasOutputStream(selected));
  const preview = useWHEPPlayer({
    whepPath: selected?.whepPath ?? "",
    enabled: Boolean(view === "detail" && selected?.automaticPreview && channelPlaybackReady(selected)),
    retry: true,
    collectStats: true,
  });
  const compatibility = selected
    ? selected.compatibility.reasons.length
      ? selected.compatibility.reasons
      : selected.input.mode.startsWith("rtp-") ? codecWarnings(selected.tracks) : []
    : [];
  const selectedIsSRTPush = selected?.input.mode === "srt-push";
  const managementDesiredAddress = bindingAddress(status?.network.management, status?.network.interfaces ?? []);
  const mediaDesiredAddress = bindingAddress(status?.network.media, status?.network.interfaces ?? []);
  const managementBinding = resolveBinding(
    status?.network.management.activeAddress,
    managementDesiredAddress || "*",
    status?.network.management.restartRequired ?? false,
    status?.settings.applyState ?? "pending",
  );
  const mediaBinding = resolveBinding(
    status?.network.media.activeAddress,
    mediaDesiredAddress || "*",
    false,
    status?.settings.applyState ?? "pending",
  );
  const mediaBindingAvailable = !status?.network.media.resolutionError && status?.network.media.activeAddress !== undefined;
  const selectedMediaHost = mediaBindingAvailable
    ? mediaHost(mediaBinding.address, window.location.hostname)
    : "";
  const activeRelayAddress = selected?.relay?.listenerActive ? selected.relay.listenerAddress : undefined;
  const selectedSRTURL = selectedIsSRTPush
    ? srtListenerURL(activeRelayAddress, window.location.hostname, selected?.input.srt?.latencyMs)
    : "";
  const selectedSRTActivePort = selectedSRTURL ? listenerPort(activeRelayAddress ?? "") : "";
  const selectedSRTHost = selectedIsSRTPush
    ? activeListenerHost(activeRelayAddress, window.location.hostname)
    : selectedMediaHost;
  const selectedSRTAdvancedURL = selectedIsSRTPush && selected && !selected.input.srt?.sdp
    ? srtPublishURL(selected.path, status?.network.media.activeListeners?.srt, window.location.hostname)
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
  const pendingEmbedURL = selected && pendingOutputOrigin ? absolutePath(pendingOutputOrigin, selected.embedPath) : "";
  const whepURL = selected ? absolutePath(outputOrigin, selected.whepPath) : "";
  const iframeCode = selected ? iframeEmbedCode(embedURL, selected.name) : "";

  useEffect(() => {
    passphraseRequestRef.current?.abort();
    passphraseRequestRef.current = null;
    setRevealedPassphrase(null);
    setPassphraseError("");
    setRevealingPassphrase(false);
    setPreviewSettingError("");
    setConfirmingDelete(false);
    setDeleting(false);
    return () => {
      passphraseRequestRef.current?.abort();
      passphraseRequestRef.current = null;
    };
  }, [selectedID, selected?.revision]);

  useEffect(() => {
    const target = pendingHeadingFocusRef.current;
    if (target !== view) return;
    const heading = target === "overview" ? overviewHeadingRef.current : detailHeadingRef.current;
    if (!heading) return;
    pendingHeadingFocusRef.current = null;
    heading.focus();
  }, [selectedID, status, view]);

  useEffect(() => {
    const stale = Boolean(statusError && status);
    if (stale && !previousStatusErrorRef.current) {
      setLiveAnnouncement("Dashboard status is stale. Last known data and playback are retained.");
    } else if (!statusError && previousStatusErrorRef.current) {
      setLiveAnnouncement("Dashboard status recovered.");
    }
    previousStatusErrorRef.current = Boolean(statusError);
  }, [status, statusError]);

  useEffect(() => {
    if (!status) return;
    if (!status.media.reachable && previousMediaReachableRef.current !== false) {
      showToast({
        kind: "error",
        message: "MediaMTX is unavailable. Channel status and playback may be affected.",
        timeout: 7_000,
      });
    }
    previousMediaReachableRef.current = status.media.reachable;
  }, [showToast, status?.media.reachable]);

  useEffect(() => {
    const announcement = view === "detail" && selected
      ? `${selected.name} preview: ${previewTitle(preview.state, selected.automaticPreview, isLive)}.`
      : "";
    if (announcement && announcement !== previousPreviewAnnouncementRef.current) {
      previousPreviewAnnouncementRef.current = announcement;
      setLiveAnnouncement(announcement);
    }
  }, [isLive, preview.state, selected?.automaticPreview, selected?.id, selected?.name, view]);

  useEffect(() => {
    if (confirmingDelete) {
      confirmDeleteRef.current?.focus();
    } else if (restoreDeleteFocusRef.current) {
      restoreDeleteFocusRef.current = false;
      deleteButtonRef.current?.focus();
    }
  }, [confirmingDelete]);

  const stepChannel = (delta: number) => {
    const list = status?.channels ?? [];
    if (list.length < 2) return;
    const index = list.findIndex((item) => item.id === selectedID);
    const next = list[(index + delta + list.length) % list.length];
    if (next) showChannel(next.id, "replace", false);
  };

  const showOverview = (historyMode: DashboardHistoryMode = "push") => {
    pendingHeadingFocusRef.current = "overview";
    setView("overview");
    window.history[`${historyMode}State`](null, "", dashboardURL(window.location.href));
  };

  const showChannel = (channelID: string, historyMode: DashboardHistoryMode = "push", focusHeading = true) => {
    if (focusHeading) pendingHeadingFocusRef.current = "detail";
    setSelectedID(channelID);
    setView("detail");
    window.history[`${historyMode}State`](null, "", dashboardURL(window.location.href, channelID));
  };

  const openCreate = () => {
    if (statusStale) return;
    setEditingID(null);
    setEditingRevision(null);
    setForm(emptyForm(status?.settings, nextSRTListenPort(status)));
    setFormError("");
    setFormConflict(false);
  };

  const refreshStatus = () => {
    if (statusPollingRef.current) statusPollingRef.current.runNow();
    else setRefreshToken((current) => current + 1);
  };

  const restartGateway = async () => {
    if (!status?.gateway.restartRequired || restarting || statusStale) return;
    const desiredAddress = status.network.management.resolvedAddress ?? resolveInterfaceBinding(status.settings.managementBindAddress, status.network.interfaces);
    if (!desiredAddress) {
      setRestartError(status.network.management.resolutionError ?? "The selected interface has no usable address");
      showToast({ kind: "error", message: "Gateway restart is blocked by the selected interface." });
      return;
    }
    const desiredOrigin = managementOrigin(
      desiredAddress,
      status.network.management.port,
      window.location,
    );
    const destination = new URL("/", `${desiredOrigin}/`);
    setRestarting(true);
    setRestartError("");
    try {
      const { response, body } = await requestAPI("/api/v1/restart", { method: "POST" });
      if (response.status !== 202) {
        throw new APIRequestError(response.status, apiErrorMessage(body, response.status, "Restart request failed"));
      }
      showToast({ kind: "info", message: "Gateway restart requested." });
      window.setTimeout(() => {
        if (destination.origin === window.location.origin && window.location.pathname === "/" && !window.location.search && !window.location.hash) {
          window.location.reload();
        } else {
          window.location.assign(destination.toString());
        }
      }, 1_000);
    } catch (error) {
      if (isRequestTimeoutError(error)) {
        setRestartError("The restart request timed out. Its outcome is indeterminate; current status is being refreshed.");
        refreshStatus();
      } else {
        setRestartError(`${error instanceof Error ? error.message : "The restart request failed"}. Verify the Docker restart policy and try again.`);
      }
      showToast({ kind: "error", message: "Gateway restart failed." });
      setRestarting(false);
    }
  };

  const openEdit = (item: Channel, allowStale = false) => {
    if (statusStale && !allowStale) return;
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
    setEditingRevision(item.revision);
    setForm(next);
    setFormError("");
    setFormConflict(false);
  };

  const openSettings = () => {
    if (!status || statusStale) return;
    const { revision, applyState: _applyState, applyError: _applyError, updatedAt: _updatedAt, ...editable } = status.settings;
    setSettingsRevision(revision);
    setSettingsForm({ ...editable, webRTCAdditionalHosts: status.settings.webRTCAdditionalHosts.join(", ") });
    setSettingsError("");
    setSettingsConflict(false);
  };

  const changeChannelForm = (next: ChannelForm) => {
    if (form && form.mode !== next.mode) setRevealedPassphrase(null);
    setForm(next);
  };

  const saveSettings = async () => {
    if (!settingsForm || settingsRevision === null || statusStale) return;
    setSaving(true);
    setSettingsError("");
    setSettingsConflict(false);
    try {
      const { response, body: result } = await requestAPI("/api/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": quoteRevision(settingsRevision) },
        body: JSON.stringify({
          ...settingsForm,
          srtAddress: listenerAddress(settingsForm.mediaBindAddress, settingsForm.srtAddress, listenerPort(settingsForm.srtAddress)),
          webRTCLocalUDPAddress: listenerAddress(settingsForm.mediaBindAddress, settingsForm.webRTCLocalUDPAddress, listenerPort(settingsForm.webRTCLocalUDPAddress)),
          webRTCLocalTCPAddress: listenerAddress(settingsForm.mediaBindAddress, settingsForm.webRTCLocalTCPAddress, listenerPort(settingsForm.webRTCLocalTCPAddress), true),
          webRTCAdditionalHosts: settingsForm.webRTCAdditionalHosts.split(",").map((host) => host.trim()).filter(Boolean),
        }),
      });
      if (response.status === 412) {
        setSettingsConflict(true);
        setSettingsError(`These settings were opened at revision ${settingsRevision}, but the Gateway has a newer revision. Your changes are preserved. Reload the latest settings before saving again.`);
        refreshStatus();
        return;
      }
      if (!response.ok) throw new APIRequestError(response.status, apiErrorMessage(result, response.status, "Settings request failed"));
      if (!isGlobalSettings(result)) throw new Error("Gateway returned malformed settings data");
      setStatus((current) => current ? { ...current, settings: result } : current);
      setSettingsRevision(result.revision);
      if (result.applyState === "error") {
        const failed = result;
        setSettingsError(`Settings saved, but the media plane rejected them: ${failed.applyError ?? "apply failed"}`);
        refreshStatus();
        showToast({ kind: "error", message: "Settings saved, but the media plane rejected them." });
        return;
      }
      setSettingsForm(null);
      refreshStatus();
      showToast({ kind: "success", message: "Settings saved." });
    } catch (error) {
      if (isRequestTimeoutError(error)) {
        setSettingsError("The settings request timed out. Its outcome is indeterminate; your form is preserved while current status is refreshed.");
        refreshStatus();
      } else {
        setSettingsError(error instanceof Error ? error.message : "Unable to save settings");
      }
      showToast({ kind: "error", message: "Settings were not saved." });
    } finally {
      setSaving(false);
    }
  };

  const updateAutomaticPreview = async (item: Channel, automaticPreview: boolean) => {
    if (statusStale || previewSavingIDs.has(item.id)) return;
    setPreviewSavingIDs((current) => new Set(current).add(item.id));
    setPreviewSettingError("");
    try {
      const { response, body: result } = await requestAPI(`/api/v1/channels/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": quoteRevision(item.revision) },
        body: JSON.stringify({ automaticPreview }),
      });
      if (response.status === 412) {
        setPreviewSettingError("The channel changed before the preview preference could be saved. Current status is being refreshed; try again afterward.");
        refreshStatus();
        return;
      }
      if (!response.ok) throw new APIRequestError(response.status, apiErrorMessage(result, response.status, "Preview request failed"));
      if (!isChannelPreference(result)) throw new Error("Gateway returned a malformed preview preference");
      setStatus((current) => current ? {
        ...current,
        channels: current.channels.map((channel) => channel.id === item.id ? {
          ...channel,
          automaticPreview: result.automaticPreview,
          revision: result.revision,
          updatedAt: result.updatedAt,
        } : channel),
      } : current);
    } catch (error) {
      if (isRequestTimeoutError(error)) {
        setPreviewSettingError("The preview request timed out. Its outcome is indeterminate; current status is being refreshed.");
        refreshStatus();
      } else {
        setPreviewSettingError(error instanceof Error ? error.message : "Unable to update preview");
      }
      showToast({ kind: "error", message: "Preview was not updated." });
    } finally {
      setPreviewSavingIDs((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const revealPassphrase = async (item: Channel) => {
    passphraseRequestRef.current?.abort();
    const abort = new AbortController();
    passphraseRequestRef.current = abort;
    setRevealingPassphrase(true);
    setPassphraseError("");
    try {
      const { response, body: result } = await requestAPI(`/api/v1/channels/${encodeURIComponent(item.id)}/srt-passphrase`, {
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.ok) throw new APIRequestError(response.status, apiErrorMessage(result, response.status, "Passphrase request failed"));
      if (!isPassphraseResponse(result)) throw new Error("Gateway returned malformed passphrase data");
      if (passphraseRequestRef.current !== abort) return;
      const current = selectedRevisionRef.current;
      if (!current || current.id !== item.id || current.revision !== result.revision || result.revision !== item.revision) {
        setRevealedPassphrase(null);
        setPassphraseError("The channel changed while the passphrase was being read. Reveal it again from the latest revision.");
        return;
      }
      setRevealedPassphrase(result.configured ? { channelID: item.id, revision: result.revision, value: result.passphrase } : null);
    } catch (error) {
      if (abort.signal.aborted || passphraseRequestRef.current !== abort) return;
      setPassphraseError(isRequestTimeoutError(error)
        ? "The passphrase request timed out. Try again."
        : error instanceof Error ? error.message : "Unable to reveal passphrase");
    } finally {
      if (passphraseRequestRef.current === abort) {
        passphraseRequestRef.current = null;
        setRevealingPassphrase(false);
      }
    }
  };

  const saveChannel = async () => {
    if (!form || statusStale || (editingID !== null && editingRevision === null)) return;
    setSaving(true);
    setFormError("");
    setFormConflict(false);
    setRevealedPassphrase(null);
    try {
      const { response, body: result } = await requestAPI(
        editingID ? `/api/v1/channels/${encodeURIComponent(editingID)}` : "/api/v1/channels",
        {
          method: editingID ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...(editingID && editingRevision !== null ? { "If-Match": quoteRevision(editingRevision) } : {}),
          },
          body: JSON.stringify(channelPayload(form)),
        },
      );
      if (response.status === 412 && editingID) {
        setFormConflict(true);
        setFormError(`This channel was opened at revision ${editingRevision}, but the Gateway has a newer revision. Your changes are preserved. Reload the latest channel before saving again.`);
        refreshStatus();
        return;
      }
      if (!response.ok) {
        throw new APIRequestError(response.status, apiErrorMessage(result, response.status, "Channel request failed"));
      }
      if (!isChannel(result)) throw new Error("Gateway returned malformed channel data");
      const saved = result;
      setSelectedID(saved.id);
      setForm(null);
      refreshStatus();
      showToast({
        kind: saved.applyState === "error" ? "error" : "success",
        message: saved.applyState === "error"
          ? "Channel saved, but its configuration was not applied."
          : editingID ? "Channel updated." : "Channel created.",
      });
    } catch (error) {
      if (isRequestTimeoutError(error)) {
        setFormError("The channel request timed out. Its outcome is indeterminate; your form is preserved while current status is refreshed.");
        refreshStatus();
      } else {
        setFormError(error instanceof Error ? error.message : "Unable to save channel");
      }
      showToast({ kind: "error", message: "Channel was not saved." });
    } finally {
      setSaving(false);
    }
  };

  const deleteChannel = async (item: Channel) => {
    if (statusStale || deleting) return;
    setDeleteError("");
    setDeleting(true);
    try {
      const { response, body } = await requestAPI(`/api/v1/channels/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (!response.ok) {
        throw new APIRequestError(response.status, apiErrorMessage(body, response.status, "Unable to delete channel"));
      }
      if (response.status !== 202) {
        setSelectedID(status?.channels.find((channel) => channel.id !== item.id)?.id ?? "");
        showOverview("replace");
      }
      refreshStatus();
      setConfirmingDelete(false);
      showToast({ kind: "success", message: response.status === 202 ? "Channel deletion is pending." : "Channel deleted." });
    } catch (error) {
      if (isRequestTimeoutError(error)) {
        setDeleteError("The delete request timed out. Its outcome is indeterminate; current status is being refreshed.");
        refreshStatus();
      } else {
        setDeleteError(error instanceof Error ? error.message : "Unable to delete channel");
      }
      showToast({ kind: "error", message: "Channel was not deleted." });
    } finally {
      setDeleting(false);
    }
  };

  const reloadLatestChannel = async () => {
    if (!editingID || saving) return;
    setSaving(true);
    try {
      const { response, body } = await requestAPI(`/api/v1/channels/${encodeURIComponent(editingID)}`, { cache: "no-store" });
      if (!response.ok) throw new APIRequestError(response.status, apiErrorMessage(body, response.status, "Channel reload failed"));
      if (!isChannel(body)) throw new Error("Gateway returned malformed channel data");
      setStatus((current) => current ? {
        ...current,
        channels: current.channels.map((channel) => channel.id === body.id ? { ...channel, ...body } : channel),
      } : current);
      openEdit(body, true);
      setFormError("");
      setFormConflict(false);
      setRevealedPassphrase(null);
    } catch (error) {
      setFormError(isRequestTimeoutError(error)
        ? "Reloading the latest channel timed out. Your changes remain preserved."
        : error instanceof Error ? error.message : "Unable to reload the latest channel");
    } finally {
      setSaving(false);
    }
  };

  const reloadLatestSettings = async () => {
    if (!settingsForm || saving) return;
    setSaving(true);
    try {
      const { response, body } = await requestAPI("/api/v1/settings", { cache: "no-store" });
      if (!response.ok) throw new APIRequestError(response.status, apiErrorMessage(body, response.status, "Settings reload failed"));
      if (!isGlobalSettings(body)) throw new Error("Gateway returned malformed settings data");
      const { revision, applyState: _applyState, applyError: _applyError, updatedAt: _updatedAt, ...editable } = body;
      setSettingsRevision(revision);
      setSettingsForm({ ...editable, webRTCAdditionalHosts: body.webRTCAdditionalHosts.join(", ") });
      setSettingsError("");
      setSettingsConflict(false);
      setStatus((current) => current ? { ...current, settings: body } : current);
    } catch (error) {
      setSettingsError(isRequestTimeoutError(error)
        ? "Reloading the latest settings timed out. Your changes remain preserved."
        : error instanceof Error ? error.message : "Unable to reload the latest settings");
    } finally {
      setSaving(false);
    }
  };

  const cancelDeleteConfirmation = () => {
    restoreDeleteFocusRef.current = true;
    setConfirmingDelete(false);
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
  const displayedPassphrase = selected && revealedPassphrase && revealedPassphrase.channelID === selected.id && revealedPassphrase.revision === selected.revision
    ? revealedPassphrase.value
    : null;
  const modalOpen = Boolean(form || settingsForm || diagnosticsTarget);

  return (
    <div className="app-shell">
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{liveAnnouncement}</div>
      <header className="topnav" inert={modalOpen ? true : undefined} aria-hidden={modalOpen ? true : undefined}>
        <button className="topnav-brand" type="button" onClick={() => showOverview()}>
          <span className="brand-mark" aria-hidden="true">SD</span>
          <span className="brand-copy">
            <strong>Signal Desk</strong>
            <small>WebRTC gateway</small>
          </span>
        </button>

        <nav className="topnav-links" aria-label="Primary">
          <button
            className={!settingsForm ? "topnav-link active" : "topnav-link"}
            type="button"
            aria-current={!settingsForm ? "page" : undefined}
            onClick={() => showOverview()}
          >Overview</button>
          <button className={settingsForm ? "topnav-link active" : "topnav-link"} type="button" aria-current={settingsForm ? "page" : undefined} onClick={openSettings} disabled={!status || statusStale} title={`Global settings - ${gatewaySettingsState}`}>Settings</button>
        </nav>

        <button
          className="topnav-diagnostics"
          type="button"
          aria-haspopup="dialog"
          aria-label="Open system diagnostics"
          title="Open system diagnostics"
          onClick={() => setDiagnosticsTarget({ scope: "system" })}
        >
          Diagnostics
        </button>
      </header>

      <main className={view === "overview" ? "workspace overview-workspace" : "workspace"} inert={modalOpen ? true : undefined} aria-hidden={modalOpen ? true : undefined}>
        <div className="gateway-notices" aria-label="Gateway notices">
          {statusError && <ScopedNotice scope="Gateway" message={`${statusError}. Gateway will retry automatically.`} />}
          {status?.settings.applyState === "pending" && <ScopedNotice scope="Gateway" message="Global settings changes are pending and have not yet been confirmed applied." />}
          {status?.settings.applyState === "error" && <ScopedNotice scope="Gateway" message={`Global settings saved but not applied: ${status.settings.applyError ?? "Media plane apply failed"}`} />}
          {status?.network.management.resolutionError && <ScopedNotice scope="Gateway" message={`Management interface unavailable: ${status.network.management.resolutionError}`} />}
          {status?.network.media.resolutionError && <ScopedNotice scope="Gateway" message={`Media interface unavailable: ${status.network.media.resolutionError}`} />}
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
                  <button className="button restart-button" type="button" disabled={restarting || statusStale || Boolean(status.network.management.resolutionError)} onClick={() => void restartGateway()}>
                    {restarting ? "Restarting..." : "Restart Gateway"}
                  </button>
                )}
              </div>
              {restartError && <div className="restart-error" role="alert"><strong>Restart failed.</strong> {restartError}</div>}
            </div>
          )}
        </div>

        <nav className="detail-breadcrumb" aria-label="Channel navigation">
          {view === "overview" ? <span className="crumb-current" aria-current="page">Overview</span> : <>
            <button className="crumb-back" type="button" onClick={() => showOverview()}><ArrowLeftIcon /> Overview</button>
            <span className="crumb-divider">/</span>
            <div className="crumb-stepper">
              <button className="crumb-step" type="button" disabled={(status?.channels.length ?? 0) < 2} onClick={() => stepChannel(-1)} aria-label="Previous channel"><ChevronLeftIcon /></button>
              <span aria-current="page">{selected?.name ?? "Channel"}</span>
              <button className="crumb-step" type="button" disabled={(status?.channels.length ?? 0) < 2} onClick={() => stepChannel(1)} aria-label="Next channel"><ChevronRightIcon /></button>
            </div>
          </>}
        </nav>

        {view === "detail" && (<>
        <header className="topbar">
          <div>
            <span className="eyebrow">{selected ? inputModeLabel(selected.input.mode) : "GATEWAY"}</span>
             <h1 ref={detailHeadingRef} tabIndex={-1}>{workspaceTitle}</h1>
          </div>
          <div className="topbar-actions">
            {selected && (confirmingDelete ? <div className="inline-confirm" role="group" aria-label="Confirm channel deletion">
              <span>Disconnect viewers and delete?</span>
              <button ref={confirmDeleteRef} className="button danger" type="button" disabled={deleting || statusStale} onClick={() => void deleteChannel(selected)}>{deleting ? "Deleting..." : "Confirm delete"}</button>
              <button className="button secondary" type="button" disabled={deleting} onClick={cancelDeleteConfirmation}>Cancel</button>
            </div> : <>
              <button ref={deleteButtonRef} className="button danger ghost-danger" type="button" disabled={selected.applyState === "deleting" || statusStale} onClick={() => setConfirmingDelete(true)}>{selected.applyState === "deleting" ? "Deletion pending" : "Delete"}</button>
              <button className="button secondary" type="button" disabled={selected.applyState === "deleting" || statusStale} onClick={() => openEdit(selected)}>Configure</button>
            </>)}
            {status && !selected && <button className="button secondary" type="button" onClick={status.channels.length ? undefined : openCreate} disabled={status.channels.length > 0 || statusStale}>Create channel</button>}
            {selected ? <button
              className={statusError || selectedFault ? "state-pill fault" : isLive ? "state-pill live" : "state-pill"}
              type="button"
              aria-haspopup="dialog"
              aria-label={`Open diagnostics for ${selected.name}. ${statusError ? "Status stale" : channelStateLabel(selected)}`}
              title={`Open channel diagnostics - ${selected.name}`}
              onClick={() => setDiagnosticsTarget({ scope: "channel", channelID: selected.id, channelName: selected.name })}
            >
              <span className={statusError || selectedFault ? "signal fault" : isLive ? "signal online" : "signal"} />
              {statusError ? "Status stale" : channelStateLabel(selected)}
            </button> : <div className="state-pill"><span className="signal" />{status === null ? "Loading" : status.channels.length ? "Selecting" : "Empty"}</div>}
          </div>
        </header>

        <div className="channel-notices" aria-label="Channel notices">
          {selected?.applyState === "pending" && <ScopedNotice scope={`Channel · ${selected.name}`} message="Configuration changes are pending and the channel is not ready for playback yet." />}
          {selected?.applyState === "error" && <ScopedNotice scope={`Channel · ${selected.name}`} message={`Configuration saved but not applied: ${selected.applyError ?? "Channel apply failed"}`} />}
          {selected?.applyState === "deleting" && <ScopedNotice
            scope={`Channel · ${selected.name}`}
            message={selected.applyError ? `Deletion is pending after cleanup failed: ${selected.applyError}` : "Deletion is pending and will be retried automatically."}
            action={selected.applyError ? <button className="button secondary" type="button" disabled={deleting || statusStale} onClick={() => void deleteChannel(selected)}>{deleting ? "Retrying..." : "Retry deletion"}</button> : undefined}
          />}
          {selected && deleteError && <ScopedNotice scope={`Channel · ${selected.name}`} message={`Deletion failed: ${deleteError}`} />}
          {selected?.enabled && selected.applyState !== "deleting" && selected.relay && (selected.relay.state === "retrying" || selected.relay.state === "stopped") && <ScopedNotice scope={`Channel · ${selected.name}`} message={`SRT listener is unavailable: ${selected.relay.lastError ?? "the relay process stopped"}. Gateway will retry automatically.`} />}
          {selected && previewSettingError && <ScopedNotice scope={`Channel · ${selected.name}`} message={`Preview was not updated: ${previewSettingError}`} />}
        </div>
        </>)}

        {view === "overview" ? (
          <>
            <ChannelOverview
              channels={status?.channels ?? []}
              loading={status === null}
              error={statusError}
              rates={streamRates}
              query={overviewQuery}
              filter={overviewFilter}
              layout={overviewLayout}
              onQueryChange={setOverviewQuery}
              onFilterChange={setOverviewFilter}
              onLayoutChange={setOverviewLayout}
              onSelect={(id) => showChannel(id)}
              onEdit={openEdit}
              previewSavingIDs={previewSavingIDs}
              onAutomaticPreviewChange={(item, enabled) => void updateAutomaticPreview(item, enabled)}
              onCreate={openCreate}
              onRetry={refreshStatus}
              mutationsDisabled={statusStale}
              headingRef={overviewHeadingRef}
            />
            <ResourceFooter resources={status?.resources} disconnected={Boolean(statusError)} />
          </>
        ) : selected ? (
          <>
            <section className="connection-grid" aria-label="Channel connections">
              <InputConnectionPanel
                channel={selected}
                bindingState={mediaBinding.state}
                bindingName={bindingLabel(mediaBinding.address, status?.network.interfaces ?? [])}
                bindingError={status?.settings.applyError}
                mediaHost={selectedSRTHost}
                srtURL={selectedSRTURL}
                activeSRTPort={selectedSRTActivePort}
                advancedSRTURL={selectedSRTAdvancedURL}
                passphrase={displayedPassphrase}
                passphraseLoading={revealingPassphrase}
                passphraseError={passphraseError}
                onReveal={() => void revealPassphrase(selected)}
                onHide={() => setRevealedPassphrase(null)}
              />

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
                  desiredLabel={managementBinding.desiredAddress ? bindingLabel(status?.network.management.desiredAddress ?? managementBinding.desiredAddress, status?.network.interfaces ?? []) : undefined}
                  scope="Gateway › Web UI & API interface"
                />
                <div className="connection-rows">
                  <ConnectionRow label={managementBinding.state === "pending-restart" ? "Current viewer URL" : "Viewer URL"} value={viewerURL} openURL />
                  {pendingViewerURL && <ConnectionRow label="Viewer URL after restart" value={pendingViewerURL} secondary />}
                  <ConnectionRow label={managementBinding.state === "pending-restart" ? "Current channel embed URL" : "Channel embed URL"} value={embedURL} openURL />
                  {pendingEmbedURL && <ConnectionRow label="Channel embed URL after restart" value={pendingEmbedURL} secondary />}
                  <ConnectionRow label="Iframe embed code" value={iframeCode} />
                  <ConnectionRow label="WHEP API endpoint" value={whepURL} />
                </div>
              </article>
            </section>

            <article className="panel preview-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">WEBRTC PREVIEW</span>
                  <h2>{previewTitle(preview.state, selected.automaticPreview, isLive)}</h2>
                </div>
                <Tooltip content="Controls whether the dashboard opens a muted WebRTC preview for this channel." placement="left">
                  {(tooltip) => <button
                    {...tooltip}
                    className={selected.automaticPreview ? "toggle active" : "toggle"}
                    type="button"
                    disabled={previewSavingIDs.has(selected.id) || selected.applyState === "deleting" || statusStale}
                    aria-label={selected.automaticPreview ? "Disable preview" : "Enable preview"}
                    aria-pressed={selected.automaticPreview}
                    onClick={() => void updateAutomaticPreview(selected, !selected.automaticPreview)}
                  ><span /></button>}
                </Tooltip>
              </div>
              <div className="preview-stage">
                <video ref={preview.videoRef} autoPlay playsInline muted controls />
                {!selected.automaticPreview && <div className="preview-message overlay-message" role="status">
                  <span className="preview-icon">OFF</span>
                  <strong>Preview disabled for this channel</strong>
                  <p>Enable Preview to create a muted dashboard WHEP reader when output is ready.</p>
                </div>}
                {selected.automaticPreview && !isLive && <div className={`preview-message overlay-message${channelHasFault(selected) ? " error-message" : ""}`} role={channelHasFault(selected) ? "alert" : "status"}>
                  <span className="preview-icon">{channelHasFault(selected) ? "ERR" : inputLive ? "PREP" : "OFF"}</span>
                  <strong>{channelStateLabel(selected)}</strong>
                  <p>{previewOfflineDetail(selected)}</p>
                </div>}
                {selected.automaticPreview && isLive && preview.state === "connecting" && <div className="preview-message overlay-message" role="status"><span className="preview-icon pulse">ICE</span><strong>Establishing WHEP session</strong><p>Gathering LAN candidates and waiting for media.</p></div>}
                {selected.automaticPreview && isLive && preview.state === "error" && <div className="preview-message overlay-message error-message" role="alert"><span className="preview-icon">ERR</span><strong>Preview unavailable</strong><p>{preview.error} Retrying automatically.</p></div>}
                {selected.automaticPreview && isLive && preview.state === "playing" && preview.hasAudio && !preview.hasVideo && <div className="preview-message audio-message" role="status"><span className="preview-icon">AUD</span><strong>Audio-only stream</strong><p>Audio is playing without a video track.</p></div>}
              </div>
            </article>

            <section className="metric-strip" aria-label="Live stream metrics">
              <Metric label="Input rate" help="Current bitrate entering the channel, calculated from successive ingest byte counters." value={hasInput ? formatBitrate(selectedRates?.inputBitrateBps) : "—"} detail={hasInput ? `${formatBytes(selected.inboundBytes)} received` : "waiting for input"} />
              <Metric label="Output rate" help="Current bitrate published on the browser-compatible output path before viewer fan-out." value={hasOutput ? formatBitrate(selectedRates?.outputBitrateBps) : "—"} detail={hasOutput ? `${formatBytes(selected.outputInboundBytes)} published` : "no active output"} />
              <Metric label="Delivery" help="Combined bitrate sent from the output path to all active readers. It can exceed output rate when multiple viewers are connected." value={hasOutput ? formatBitrate(selectedRates?.deliveryBitrateBps) : "—"} detail={hasOutput ? `${formatBytes(selected.outboundBytes)} sent` : "no active output"} />
              <Metric label="Viewers" help="Readers currently attached to this channel's browser-compatible output path, including the dashboard preview." value={hasOutput ? String(selected.readers.length) : "—"} detail={hasOutput ? "active readers" : "no active output"} />
            </section>

            <section className="stream-grid" aria-label="Input and output stream details">
              <article className="panel stream-panel input-stream-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">INPUT STREAM</span>
                    <h2>Source media</h2>
                  </div>
                  <span className={inputLive ? "stream-state live" : "stream-state"}>{inputLive ? "ONLINE" : "OFFLINE"}</span>
                </div>
                {hasInput ? <>
                  <div className="stream-summary">
                    <StreamFact label="Stream bitrate" help="Recent ingest bitrate derived from the MediaMTX byte counter." value={formatBitrate(selectedRates?.inputBitrateBps)} />
                    <StreamFact label="Received total" help="Cumulative bytes received during the current input generation." value={formatBytes(selected.inboundBytes)} />
                    <StreamFact label="Input errors" help="Media frames MediaMTX could not parse correctly during the current input generation." value={`${selected.inboundFramesInError} frames`} warning={selected.inboundFramesInError > 0} />
                    <StreamFact label="Tracks" value={String(selected.tracks.length)} />
                  </div>
                  <MediaTracks direction="input" tracks={selected.tracks} />
                </> : <StreamIdle title="No active input" detail="Stream statistics and media details will appear when the source connects." />}
              </article>

              <article className="panel stream-panel output-stream-panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">OUTPUT STREAM</span>
                    <h2>Viewer media</h2>
                  </div>
                  <span className={isLive ? "stream-state live" : "stream-state"}>{isLive ? "READY" : "WAITING"}</span>
                </div>
                {hasOutput ? <>
                  <div className="stream-summary">
                    <StreamFact label="Stream bitrate" help="Rate entering the output path after direct routing or compatibility conversion." value={formatBitrate(selectedRates?.outputBitrateBps)} />
                    <StreamFact label="Delivery bitrate" help="Combined rate sent to every active output reader." value={formatBitrate(selectedRates?.deliveryBitrateBps)} />
                    <StreamFact label="Delivered total" value={formatBytes(selected.outboundBytes)} />
                    <StreamFact label="Preview transport" help="ICE network path used by this browser's dashboard preview, such as UDP or TCP." value={preview.stats?.icePath ?? (selected.automaticPreview ? "Gathering" : "Preview disabled")} />
                  </div>
                  <MediaTracks direction="output" tracks={selected.outputTracks} previewStats={preview.stats} />
                </> : <StreamIdle title="No active output" detail={hasInput ? "The input is connected while browser-compatible output is being prepared." : "Output statistics will appear after an input stream is detected."} />}
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
              <InfoLine label="Input mode" help="How media enters Gateway for this channel." value={inputModeLabel(selected.input.mode)} />
              <InfoLine label="Ingest path" value={selected.path} mono />
              <InfoLine label="WebRTC route" help="Direct passthrough avoids transcoding. Compatibility output uses an isolated FFmpeg worker when browser-safe codecs are required." value={selected.compatibility.mode === "transcoded" ? "Automatic H264/Opus compatibility" : "Direct passthrough"} />
              <InfoLine label="WHEP signaling" help="HTTP endpoint browsers use to create and control a WebRTC receive session for this channel." value={whepURL} mono />
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
                  <button className="button primary" type="button" onClick={refreshStatus}>Retry now</button>
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
                <button className="button primary" type="button" onClick={openCreate} disabled={statusStale}>Create channel</button>
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
          conflict={formConflict}
          saving={saving}
          mutationBlocked={statusStale}
          onChange={changeChannelForm}
          onClose={() => setForm(null)}
          onSave={() => void saveChannel()}
          onReloadLatest={() => void reloadLatestChannel()}
          rtpPortMin={status?.settings.rtpPortMin ?? 22000}
          srtPortDefault={nextSRTListenPort(status)}
          mediaBindingLabel={bindingLabel(mediaBinding.address, status?.network.interfaces ?? [])}
        />
      )}

      {settingsForm && status && (
        <SettingsEditor
          form={settingsForm}
          error={settingsError}
          conflict={settingsConflict}
          saving={saving}
          mutationBlocked={statusStale}
          onChange={setSettingsForm}
          onClose={() => setSettingsForm(null)}
          onSave={() => void saveSettings()}
          onReloadLatest={() => void reloadLatestSettings()}
          network={status.network}
          currentMediaBindAddress={status.network.media.activeAddress ?? status.settings.mediaBindAddress}
        />
      )}

      {diagnosticsTarget?.scope === "system" && <DiagnosticsDialog scope="system" onClose={() => setDiagnosticsTarget(null)} />}
      {diagnosticsTarget?.scope === "channel" && <DiagnosticsDialog scope="channel" channelID={diagnosticsTarget.channelID} channelName={diagnosticsTarget.channelName} onClose={() => setDiagnosticsTarget(null)} />}
    </div>
  );
}

export function App() {
  return <ToastProvider><Dashboard /></ToastProvider>;
}

function ChannelEditor({ form, editing, error, conflict, saving, mutationBlocked, rtpPortMin, srtPortDefault, mediaBindingLabel, onChange, onClose, onSave, onReloadLatest }: {
  form: ChannelForm;
  editing: boolean;
  error: string;
  conflict: boolean;
  saving: boolean;
  mutationBlocked: boolean;
  rtpPortMin: number;
  srtPortDefault: number;
  mediaBindingLabel: string;
  onChange: (form: ChannelForm) => void;
  onClose: () => void;
  onSave: () => void;
  onReloadLatest: () => void;
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
    <ModalShell labelledBy="editor-title" onClose={onClose} dismissDisabled={saving} closeLabel="Close channel editor">
        <header className="editor-header">
          <div>
            <span className="eyebrow">CHANNEL CONFIGURATION</span>
            <h2 id="editor-title">{editing ? "Edit channel" : "New channel"}</h2>
          </div>
        </header>

        <div className="editor-body">
          {error && <div className="alert editor-alert" role="alert"><span>{error}</span>{conflict && <button className="button secondary" type="button" disabled={saving} onClick={onReloadLatest}>Reload latest</button>}</div>}

          <div className="form-grid">
            <label className="field full">
              <span>Name</span>
              <input autoFocus value={form.name} maxLength={80} onChange={(event) => update("name", event.target.value)} placeholder="Studio camera" />
            </label>

            <fieldset className="field full mode-field">
              <legend>Input mode <HelpTip label="Input mode" content="Select how the source reaches Gateway. Push modes listen locally; pull mode connects outward to a source." placement="left" /></legend>
              <div className="mode-switch">
                {(["srt-push", "srt-pull", "rtp-unicast", "rtp-multicast"] as InputMode[]).map((mode) => (
                  <button key={mode} className={form.mode === mode ? "active" : ""} type="button" aria-pressed={form.mode === mode} onClick={() => switchMode(mode)}>{inputModeLabel(mode)}</button>
                ))}
              </div>
            </fieldset>

            {isRTP && (
              <>
                {form.mode === "rtp-multicast" ? (
                  <label className="field">
                    <FieldTitle help="IPv4 multicast group that carries this RTP stream. Gateway joins the group on the selected network interface.">Multicast group</FieldTitle>
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
                  <FieldTitle help="Local UDP port used to receive RTP packets for this channel. It must be unique within the configured RTP range.">UDP port</FieldTitle>
                  <input type="number" min="1" max="65535" value={form.port} onChange={(event) => update("port", event.target.value)} />
                </label>
                <label className="field">
                  <FieldTitle help="Optional sender address restriction. Packets from other source IPs are ignored.">Source IP filter</FieldTitle>
                  <input value={form.sourceIp} onChange={(event) => update("sourceIp", event.target.value)} placeholder="Optional" />
                </label>
                {form.mode === "rtp-multicast" && (
                  <label className="field">
                    <FieldTitle help="Interface used to join the multicast group, such as eth0. Leave blank only when the operating system can choose correctly.">Network interface</FieldTitle>
                    <input value={form.networkInterface} onChange={(event) => update("networkInterface", event.target.value)} placeholder="Optional, e.g. eth0" />
                  </label>
                )}
                <label className="field full">
                  <FieldTitle help="Describes RTP payload types, codecs, clock rates, and media layout so MediaMTX can interpret incoming packets.">Session description (SDP)</FieldTitle>
                  <textarea rows={9} value={form.sdp} onChange={(event) => update("sdp", event.target.value)} spellCheck={false} />
                  <small>Required because RTP payload types do not identify codecs by themselves.</small>
                </label>
              </>
            )}

            {isSRTPull && (
              <>
                <label className="field">
                  <FieldTitle help="Hostname or IP address of the remote SRT listener that Gateway should call.">Remote host</FieldTitle>
                  <input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="192.168.1.50" />
                </label>
                <label className="field">
                  <FieldTitle help="UDP port exposed by the remote SRT listener.">Remote port</FieldTitle>
                  <input type="number" min="1" max="65535" value={form.port} onChange={(event) => update("port", event.target.value)} />
                </label>
                <label className="field">
                  <FieldTitle help="Optional SRT stream identifier sent to the remote listener for routing or authorization.">Stream ID</FieldTitle>
                  <input value={form.streamId} onChange={(event) => update("streamId", event.target.value)} placeholder="Optional" />
                </label>
              </>
            )}

            {form.mode === "srt-push" && (
              <label className="field full">
                <FieldTitle help="Gateway listens on this per-channel UDP port. Configure the encoder to call the Gateway media address and this port.">Sender destination UDP port</FieldTitle>
                <input type="number" min="1024" max="65535" value={form.port} onChange={(event) => update("port", event.target.value)} />
                <small>The sender needs only this port and the gateway IP. No stream ID is required.</small>
              </label>
            )}

            {!isRTP && (
              <label className="field">
                <FieldTitle help="SRT retransmission buffer duration. Higher values tolerate more delay and packet loss but add end-to-end latency.">SRT latency</FieldTitle>
                <div className="suffix-input"><input type="number" min="20" max="8000" value={form.latencyMs} onChange={(event) => update("latencyMs", event.target.value)} /><span>ms</span></div>
                <small>60 ms is tuned for reliable cabled LANs. Increase it for lossy or long-distance links.</small>
              </label>
            )}

            {!isRTP && (
			  <>
                <div className="field full">
                  <label htmlFor="channel-srt-passphrase"><FieldTitle help="Optional SRT encryption secret. SRT requires 10 to 79 bytes and both peers must use the same value.">SRT passphrase</FieldTitle></label>
                  <input
                    id="channel-srt-passphrase"
                    type="password"
                    value={form.passphrase}
                    disabled={form.clearPassphrase}
                    onChange={(event) => onChange({ ...form, passphrase: event.target.value, clearPassphrase: false })}
                    placeholder={form.hasPassphrase ? "Stored; leave blank to keep" : "Optional, 10-79 bytes"}
                  />
                  {form.hasPassphrase && (
                    <label className="check compact"><input type="checkbox" checked={form.clearPassphrase} onChange={(event) => onChange({ ...form, clearPassphrase: event.target.checked, passphrase: event.target.checked ? "" : form.passphrase })} />Clear stored passphrase</label>
                  )}
                </div>
				<label className="field full">
				  <FieldTitle help="Required only when SRT carries elementary RTP. It maps dynamic RTP payload types to codecs.">Elementary RTP session description (SDP)</FieldTitle>
				  <textarea rows={7} value={form.srtSdp} onChange={(event) => update("srtSdp", event.target.value)} spellCheck={false} placeholder="Optional; leave blank for automatic MPEG-TS or RTP/MP2T detection" />
				  <small>Only required when SRT carries elementary RTP with dynamic payload types. Raw MPEG-TS and RTP/MP2T payload type 33 are detected automatically.</small>
				</label>
			  </>
            )}

            <label className="field">
              <FieldTitle help="Maximum simultaneous readers accepted for this channel. Dashboard preview and standalone viewers each count as readers.">Maximum viewers</FieldTitle>
              <input type="number" min="0" value={form.maxReaders} onChange={(event) => update("maxReaders", event.target.value)} />
              <small>Zero means unlimited.</small>
            </label>

            <div className="field option-stack">
              <label className="check"><input type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /><span className="check-copy">Channel enabled <HelpTip label="Channel enabled" content="Starts the configured input and makes output available. Disabling stops listeners and playback without deleting configuration." placement="left" /></span></label>
              <label className="check"><input type="checkbox" checked={form.automaticPreview} onChange={(event) => update("automaticPreview", event.target.checked)} /><span className="check-copy">Dashboard preview <HelpTip label="Dashboard preview" content="Creates a muted WebRTC reader for visible overview tiles and the selected channel when output is ready." placement="left" /></span></label>
              <label className="check"><input type="checkbox" checked={form.useAbsoluteTimestamp} onChange={(event) => update("useAbsoluteTimestamp", event.target.checked)} /><span className="check-copy">Preserve absolute timestamps <HelpTip label="Preserve absolute timestamps" content="Keeps source timing information through MediaMTX and compatibility output when the source provides usable timestamps." placement="left" /></span></label>
            </div>
          </div>
        </div>

        <footer className="editor-footer">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" disabled={saving || mutationBlocked} title={mutationBlocked ? "Current Gateway status is stale" : undefined} onClick={onSave}>{saving ? "Saving..." : editing ? "Save changes" : "Create channel"}</button>
        </footer>
    </ModalShell>
  );
}

function SettingsEditor({ form, error, conflict, saving, mutationBlocked, network, currentMediaBindAddress, onChange, onClose, onSave, onReloadLatest }: {
  form: SettingsForm;
  error: string;
  conflict: boolean;
  saving: boolean;
  mutationBlocked: boolean;
  network: Status["network"];
  currentMediaBindAddress: string;
  onChange: (form: SettingsForm) => void;
  onClose: () => void;
  onSave: () => void;
  onReloadLatest: () => void;
}) {
  const [sameInterface, setSameInterface] = useState(form.managementBindAddress === form.mediaBindAddress);
  const update = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => onChange({ ...form, [key]: value });
  const updateNumber = (key: keyof SettingsForm, value: string) => update(key, Number(value) as never);
  const updateListenerPort = (key: "srtAddress" | "webRTCLocalUDPAddress" | "webRTCLocalTCPAddress", port: string, disableWhenBlank = false) => {
    update(key, listenerAddress(form.mediaBindAddress, form[key], port, disableWhenBlank));
  };
  const managementRestartRequired = network.management.activeAddress === undefined
    ? network.management.restartRequired
    : network.management.activeAddress !== resolveInterfaceBinding(form.managementBindAddress, network.interfaces) ||
      network.management.activeSelection !== form.managementBindAddress;

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
    <ModalShell labelledBy="settings-title" onClose={onClose} dismissDisabled={saving} closeLabel="Close settings" className="settings-editor">
        <header className="editor-header">
          <div>
            <span className="eyebrow">GATEWAY CONFIGURATION</span>
            <h2 id="settings-title">Global settings</h2>
          </div>
        </header>

        <div className="editor-body">
          {error && <div className="alert editor-alert" role="alert"><span>{error}</span>{conflict && <button className="button secondary" type="button" disabled={saving} onClick={onReloadLatest}>Reload latest</button>}</div>}
          <div className="form-grid">
            <h3 className="settings-section">Control and media planes</h3>
            <p className="settings-section-note">Follow an interface to keep using its current address after DHCP changes, or retain an existing fixed address.</p>
            <div className="binding-card">
              <div className="binding-card-heading">
                <span>CONTROL PLANE</span>
                {network.management.locked && <small>ENV LOCKED</small>}
              </div>
              <label className="field">
                <FieldTitle help="Address or interface used by the dashboard, API, viewer pages, and WHEP signaling. Changing it requires a Gateway restart.">Web UI &amp; API interface</FieldTitle>
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
                <FieldTitle help="Address or interface used for SRT, RTP, and WebRTC media listeners. Changes apply live and briefly interrupt streams.">Media interface</FieldTitle>
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
              <span className="check-copy">Use the same interface for management and media <HelpTip label="Use the same interface" content="Keeps both interface selections synchronized. This is convenient on a single-LAN host but not required." placement="left" /></span>
            </label>

            <h3 className="settings-section">Dashboard and new channels</h3>
            <p className="settings-section-note">Dashboard polling changes immediately. Viewer defaults apply only when a new channel is created.</p>
            <label className="field">
              <FieldTitle help="How often the dashboard refreshes channel, transport, and resource counters. Shorter intervals create more API traffic.">Dashboard statistics interval</FieldTitle>
              <div className="suffix-input"><input type="number" min="500" max="10000" value={form.statisticsIntervalMs} onChange={(event) => updateNumber("statisticsIntervalMs", event.target.value)} /><span>ms</span></div>
            </label>
            <label className="field">
              <FieldTitle help="Default reader limit copied into newly created channels. Existing channels keep their own limits.">New-channel maximum viewers</FieldTitle>
              <input type="number" min="0" value={form.defaultMaxReaders} onChange={(event) => updateNumber("defaultMaxReaders", event.target.value)} />
              <small>Zero means unlimited.</small>
            </label>

            <h3 className="settings-section">Media plane runtime</h3>
            <p className="settings-section-note">Saving changes below live-applies the shared media service and can briefly interrupt active channels.</p>
            <label className="field">
              <FieldTitle help="Controls MediaMTX log verbosity. Debug is useful temporarily but produces substantially more output.">Media server log level</FieldTitle>
              <select value={form.logLevel} onChange={(event) => update("logLevel", event.target.value as GlobalSettings["logLevel"])}>
                <option value="error">Error</option>
                <option value="warn">Warning</option>
                <option value="info">Information</option>
                <option value="debug">Debug</option>
              </select>
            </label>
            <label className="field">
              <FieldTitle help="Maximum time MediaMTX waits for incoming media activity before treating a connection as stalled.">Media read timeout</FieldTitle>
              <input value={form.readTimeout} onChange={(event) => update("readTimeout", event.target.value)} placeholder="5s" />
            </label>
            <label className="field">
              <FieldTitle help="Maximum time MediaMTX waits while sending media before treating a reader or publisher as stalled.">Media write timeout</FieldTitle>
              <input value={form.writeTimeout} onChange={(event) => update("writeTimeout", event.target.value)} placeholder="5s" />
            </label>
            <label className="field">
              <FieldTitle help="Number of outbound media packets buffered per connection. Larger queues absorb bursts but consume more memory and can add delay.">Media write queue size</FieldTitle>
              <input type="number" min="1" value={form.writeQueueSize} onChange={(event) => updateNumber("writeQueueSize", event.target.value)} />
              <small>Must be a power of two.</small>
            </label>

            <h3 className="settings-section">Media plane · UDP transport</h3>
            <label className="field">
              <FieldTitle help="Largest UDP payload MediaMTX emits. Keep it below the network MTU after protocol headers to avoid fragmentation.">Maximum payload size</FieldTitle>
              <div className="suffix-input"><input type="number" min="576" max="65507" value={form.udpMaxPayloadSize} onChange={(event) => updateNumber("udpMaxPayloadSize", event.target.value)} /><span>bytes</span></div>
            </label>
            <label className="field">
              <FieldTitle help="Requested operating-system UDP receive buffer. The host kernel limit can cap the effective value.">Receive buffer</FieldTitle>
              <div className="suffix-input"><input type="number" min="0" max="1073741824" value={form.udpReadBufferSize} onChange={(event) => updateNumber("udpReadBufferSize", event.target.value)} /><span>bytes</span></div>
            </label>
            <label className="field">
              <FieldTitle help="First UDP port available for RTP channels. Existing channel ports must remain within the configured range.">RTP port start</FieldTitle>
              <input type="number" min="1" max="65535" value={form.rtpPortMin} onChange={(event) => updateNumber("rtpPortMin", event.target.value)} />
            </label>
            <label className="field">
              <FieldTitle help="Last UDP port available for RTP channels. The range must not overlap shared listener ports.">RTP port end</FieldTitle>
              <input type="number" min="1" max="65535" value={form.rtpPortMax} onChange={(event) => updateNumber("rtpPortMax", event.target.value)} />
            </label>

            <h3 className="settings-section">Media plane · Shared listeners</h3>
            <label className="field">
              <FieldTitle help="Shared MediaMTX SRT listener for senders that publish using a channel stream ID.">Stream-ID SRT UDP port</FieldTitle>
              <input type="number" min="1" max="65535" value={listenerPort(form.srtAddress)} onChange={(event) => updateListenerPort("srtAddress", event.target.value)} placeholder="8890" />
              <small>Direct listener for senders that use stream IDs.</small>
            </label>
            <label className="field">
              <FieldTitle help="Preferred ICE media port used by browsers. Allow this UDP port through the host firewall on the selected media interface.">WebRTC UDP port</FieldTitle>
              <input type="number" min="1" max="65535" value={listenerPort(form.webRTCLocalUDPAddress)} onChange={(event) => updateListenerPort("webRTCLocalUDPAddress", event.target.value)} placeholder="8189" />
            </label>
            <label className="field">
              <FieldTitle help="Optional ICE-over-TCP fallback for networks where UDP is blocked. UDP remains preferred for lower latency.">WebRTC TCP fallback port</FieldTitle>
              <input type="number" min="1" max="65535" value={listenerPort(form.webRTCLocalTCPAddress)} onChange={(event) => updateListenerPort("webRTCLocalTCPAddress", event.target.value, true)} placeholder="Blank disables" />
              <small>Leave blank to disable TCP fallback.</small>
            </label>

            {form.mediaBindAddress === "custom" && (
              <div className="legacy-addresses">
                <strong>Legacy custom addresses</strong>
                <p>These listeners use different legacy hosts. Selecting a unified Media interface exits legacy mode.</p>
                <div className="legacy-address-grid">
                  <label className="field full">
                    <FieldTitle help="Legacy full SRT listener address retained from an older configuration with separate listener hosts.">MediaMTX SRT address</FieldTitle>
                    <input value={form.srtAddress} onChange={(event) => update("srtAddress", event.target.value)} placeholder=":8890" />
                  </label>
                  <label className="field">
                    <FieldTitle help="Legacy full WebRTC UDP listener address retained from an older configuration.">WebRTC UDP address</FieldTitle>
                    <input value={form.webRTCLocalUDPAddress} onChange={(event) => update("webRTCLocalUDPAddress", event.target.value)} placeholder=":8189" />
                  </label>
                  <label className="field">
                    <FieldTitle help="Legacy full WebRTC TCP listener address retained from an older configuration.">WebRTC TCP fallback</FieldTitle>
                    <input value={form.webRTCLocalTCPAddress} onChange={(event) => update("webRTCLocalTCPAddress", event.target.value)} placeholder="Disabled" />
                  </label>
                </div>
              </div>
            )}

            <h3 className="settings-section">Media plane · WebRTC discovery</h3>
            <label className="field full">
              <FieldTitle help="Extra IP addresses or hostnames placed in WebRTC ICE candidates when automatic interface discovery is insufficient.">Additional advertised hosts</FieldTitle>
              <input value={form.webRTCAdditionalHosts} onChange={(event) => update("webRTCAdditionalHosts", event.target.value)} placeholder="192.168.1.10, gateway.local" />
              <small>Comma-separated LAN hostnames or IP addresses.</small>
            </label>
            <label className="check settings-check full"><input type="checkbox" checked={form.webRTCIPsFromInterfaces} onChange={(event) => update("webRTCIPsFromInterfaces", event.target.checked)} /><span className="check-copy">Advertise addresses discovered from network interfaces <HelpTip label="Advertise discovered addresses" content="Adds suitable local interface addresses to WebRTC ICE candidates. Interface-following media bindings restrict discovery to that interface." placement="left" /></span></label>
            <label className="field">
              <FieldTitle help="Maximum time allowed to establish the WebRTC signaling and ICE session before it fails.">Handshake timeout</FieldTitle>
              <input value={form.webRTCHandshakeTimeout} onChange={(event) => update("webRTCHandshakeTimeout", event.target.value)} placeholder="10s" />
            </label>
            <label className="field">
              <FieldTitle help="How long MediaMTX waits for source tracks to appear before completing WebRTC session setup.">Track gather timeout</FieldTitle>
              <input value={form.webRTCTrackGatherTimeout} onChange={(event) => update("webRTCTrackGatherTimeout", event.target.value)} placeholder="2s" />
            </label>
          </div>
        </div>

        <footer className="editor-footer">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" disabled={saving || mutationBlocked} title={mutationBlocked ? "Current Gateway status is stale" : undefined} onClick={onSave}>{saving ? "Saving..." : "Save settings"}</button>
        </footer>
    </ModalShell>
  );
}

function BindingOptions({ value, interfaces, includeCustom = false }: {
  value: string;
  interfaces: NetworkInterface[];
  includeCustom?: boolean;
}) {
  const selectedInterface = parseInterfaceBinding(value);
  const selectorCounts = new Map<string, number>();
  for (const item of interfaces) {
    const selector = interfaceBindingSelector(item);
    selectorCounts.set(selector, (selectorCounts.get(selector) ?? 0) + 1);
  }
  const interfaceOptions = interfaces.filter((item) => selectorCounts.get(interfaceBindingSelector(item)) === 1);
  const fixedOptions = interfaces.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.address === item.address) === index,
  );
  const fixedAddress = value !== "*" && value !== "custom" && selectedInterface === null;
  const fixedAvailable = fixedAddress && fixedOptions.some((item) => item.address === value);
  const available = value === "*" || value === "custom" || fixedAddress ||
    selectedInterface !== null && interfaceOptions.some((item) => interfaceBindingSelector(item) === value);
  return (
    <>
      <option value="*">All interfaces</option>
      {(includeCustom || value === "custom") && <option value="custom">Legacy custom addresses</option>}
      {fixedAddress && !fixedAvailable && <option value={value}>Fixed address - {value} (unavailable)</option>}
      {interfaceOptions.length > 0 && <optgroup label="Follow interface">
        {interfaceOptions.map((item) => {
          const selector = interfaceBindingSelector(item);
          return <option key={selector} value={selector}>{interfaceLabel(item)}</option>;
        })}
      </optgroup>}
      {fixedOptions.length > 0 && <optgroup label="Fixed address">
        {fixedOptions.map((item) => <option key={item.address} value={item.address}>{interfaceLabel(item)}</option>)}
      </optgroup>}
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

function ScopedNotice({ scope, message, action }: { scope: string; message: string; action?: ReactNode }) {
  return (
    <div className="alert scoped-notice" role="alert">
      <span className="notice-scope">{scope}</span>
      <div className="scoped-notice-content"><p>{message}</p>{action}</div>
    </div>
  );
}

export function InputConnectionPanel({ channel, bindingState, bindingName, bindingError, mediaHost: host, srtURL, activeSRTPort, advancedSRTURL, passphrase, passphraseLoading, passphraseError, onReveal, onHide }: {
  channel: Channel;
  bindingState: "active" | "pending-restart" | "unconfirmed";
  bindingName: string;
  bindingError?: string;
  mediaHost: string;
  srtURL: string;
  activeSRTPort: string;
  advancedSRTURL: string;
  passphrase: string | null;
  passphraseLoading: boolean;
  passphraseError: string;
  onReveal: () => void;
  onHide: () => void;
}) {
  const { mode, srt, rtp } = channel.input;
  const isSRT = mode === "srt-push" || mode === "srt-pull";
  const pullQuery = [
    srt?.streamId ? `streamid=${encodeURIComponent(srt.streamId)}` : "",
    srt?.latencyMs ? `latency=${srt.latencyMs}` : "",
  ].filter(Boolean).join("&");
  const pullURL = mode === "srt-pull" && srt?.host && srt.port
    ? `srt://${urlHost(srt.host)}:${srt.port}${pullQuery ? `?${pullQuery}` : ""}`
    : "";
  const title = mode === "srt-push"
    ? "Encoder destination"
    : mode === "srt-pull" ? "Remote SRT source" : mode === "rtp-multicast" ? "Multicast receiver" : "RTP receiver";

  return (
    <article className="panel connection-panel input-connection-panel">
      <div className="panel-heading connection-heading">
        <div><span className="eyebrow">INPUT CONNECTION</span><h2>{title}</h2></div>
        <span className="connection-badge">{inputModeLabel(mode).toUpperCase()}</span>
      </div>
      <BindingContext state={bindingState} activeLabel={bindingName} scope="Gateway › Media interface" error={bindingError} />
      <div className="connection-rows">
        {mode === "srt-push" && <>
          <ConnectionRow label="SRT URL" value={srtURL || "Unavailable - listener not confirmed active"} />
          <ConnectionRow label="Destination IP" value={host || "Unavailable - listener not confirmed active"} />
          <ConnectionRow label="Destination port" value={activeSRTPort || "Unavailable - listener not confirmed active"} />
          <ConnectionRow label="SRT mode" value="Caller" />
        </>}
        {mode === "srt-pull" && <>
          <ConnectionRow label="Source URL" value={pullURL || "-"} />
          <ConnectionRow label="Source host" value={srt?.host || "-"} />
          <ConnectionRow label="Source port" value={srt?.port ? String(srt.port) : "-"} />
          <ConnectionRow label="Stream ID" value={srt?.streamId || "Not configured"} />
          <ConnectionRow label="Latency" value={srt?.latencyMs ? `${srt.latencyMs} ms` : "Default"} />
        </>}
        {mode === "rtp-unicast" && <>
          <ConnectionRow label="Destination IP" value={host || "-"} />
          <ConnectionRow label="Destination port" value={rtp?.port ? String(rtp.port) : "-"} />
          <ConnectionRow label="Source IP restriction" value={rtp?.sourceIp || "Any source"} />
          <ConnectionRow label="Session description" value={rtp?.sdp || "-"} />
        </>}
        {mode === "rtp-multicast" && <>
          <ConnectionRow label="Multicast group" value={rtp?.address || "-"} />
          <ConnectionRow label="Destination port" value={rtp?.port ? String(rtp.port) : "-"} />
          <ConnectionRow label="Receive interface" value={rtp?.interface || bindingName} />
          <ConnectionRow label="Source IP restriction" value={rtp?.sourceIp || "Any source"} />
          <ConnectionRow label="Session description" value={rtp?.sdp || "-"} />
        </>}
        <PassphraseRow applicable={isSRT} configured={Boolean(srt?.hasPassphrase)} passphrase={passphrase} loading={passphraseLoading} error={passphraseError} onReveal={onReveal} onHide={onHide} />
        {mode === "srt-push" && <ConnectionRow label="MPEG-TS-only stream-ID URL" value={advancedSRTURL || "Unavailable - shared listener not confirmed active"} secondary />}
      </div>
    </article>
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

export function ResourceFooter({ resources, disconnected = false }: { resources?: ResourceSnapshot; disconnected?: boolean }) {
  const samplerStale = Boolean(resources && (resources.gateway.status === "stale" || resources.host.status === "stale"));
  const summary = disconnected
    ? resources ? "STALE" : "UNAVAILABLE"
    : samplerStale ? "STALE" : resources ? "LIVE" : "LOADING";
  return (
    <footer className="resource-footer" aria-label="Resource usage">
      <div className="resource-footer-heading">
        <span>Resources <HelpTip label="resource scope" content="Gateway measures its own container and the whole host. MediaMTX is isolated and excluded. Warming means CPU needs another sample; stale means the last good values are retained." placement="right" /></span>
        <small>{summary}</small>
      </div>
      <ResourceRow label="Gateway" scope={resources?.gateway} disconnected={disconnected} />
      <ResourceRow label="Host" scope={resources?.host} disconnected={disconnected} />
    </footer>
  );
}

function ResourceRow({ label, scope, disconnected }: { label: string; scope?: ResourceScope; disconnected: boolean }) {
  const available = scope && scope.status !== "unavailable";
  const displayStatus = disconnected ? available ? "stale" : "unavailable" : scope?.status;
  const cpuPercent = scope?.cpu.percent ?? null;
  const memoryPercent = scope?.memory.totalBytes
    ? scope.memory.usedBytes / scope.memory.totalBytes * 100
    : null;
  return (
    <div className={`resource-row ${displayStatus ?? "unavailable"}`}>
      <div className="resource-row-heading">
        <strong>{label}</strong>
        <small>{resourceStatusLabel(displayStatus)}</small>
      </div>
      <div className="resource-metrics">
        <ResourceMetric
          label="CPU"
          scopeLabel={label}
          help={label === "Gateway"
            ? `Share of the Gateway container's ${scope ? scope.cpu.capacityCores : "available"} logical CPU cores. Includes FFmpeg and relay workers.`
            : "CPU busy time across every process on the host."}
          value={available ? formatResourcePercent(cpuPercent) : "—"}
          percent={cpuPercent}
        />
        <ResourceMetric
          label="RAM"
          scopeLabel={label}
          help={label === "Gateway"
            ? "Gateway container working memory, excluding inactive file cache, compared with its configured memory limit."
            : "Memory used across the whole host, calculated from Linux available memory."}
          value={available ? formatResourceMemory(scope.memory.usedBytes, scope.memory.totalBytes) : "—"}
          percent={memoryPercent}
        />
      </div>
    </div>
  );
}

function ResourceMetric({ label, scopeLabel, help, value, percent }: { label: string; scopeLabel: string; help: string; value: string; percent: number | null }) {
  const bounded = percent === null ? null : Math.max(0, Math.min(percent, 100));
  return (
    <div className="resource-metric">
      <div><span>{label} <HelpTip label={`${label} resource metric`} content={help} placement="right" /></span><strong>{value}</strong></div>
      <span
        className="resource-meter"
        role={bounded === null ? undefined : "progressbar"}
        aria-label={bounded === null ? undefined : `${scopeLabel} ${label} utilization`}
        aria-valuemin={bounded === null ? undefined : 0}
        aria-valuemax={bounded === null ? undefined : 100}
        aria-valuenow={bounded === null ? undefined : Math.round(bounded)}
      ><i style={{ width: `${bounded ?? 0}%` }} /></span>
    </div>
  );
}

export function resourceStatusLabel(status?: ResourceStatus) {
  if (status === "ok") return "CURRENT";
  if (status === "warming") return "WARMING";
  if (status === "stale") return "STALE";
  return status ? "UNAVAILABLE" : "LOADING";
}

export function formatResourcePercent(value: number | null) {
  if (value === null) return "Warming";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

export function formatResourceMemory(used: number, total: number | null) {
  const usedText = formatCompactBytes(used);
  return total ? `${usedText} / ${formatCompactBytes(total)}` : usedText;
}

export function formatCompactBytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  if (value <= 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unit;
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function ConnectionRow({ label, value, secondary = false, openURL = false }: {
  label: string;
  value: string;
  secondary?: boolean;
  openURL?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const help = connectionHelp(label);
  const available = value !== "-" && !value.startsWith("Unavailable");
  return (
    <div className={`connection-row${secondary ? " secondary-row" : ""}`}>
      <label htmlFor={`connection-${label.replaceAll(" ", "-").toLowerCase()}`}>{label}{help && <HelpTip label={label} content={help} placement="right" />}</label>
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
          {openURL && available && <a className="copy-action open-action" href={value} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>{label.toLowerCase().includes("embed") ? "Open embed" : "Open viewer"}</a>}
          <CopyButton label={label} value={available ? value : ""} input={inputRef} />
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
  const toast = useOptionalToast();
  const [feedback, setFeedback] = useState<"" | "Copied" | "Selected">("");

  useEffect(() => setFeedback(""), [value]);

  const copy = async () => {
    if (!value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setFeedback("Copied");
      toast?.showToast({ kind: "success", message: `${label} copied.` });
      return;
    } catch {
      input.current?.focus();
      input.current?.select();
      try {
        if (document.execCommand("copy")) {
          setFeedback("Copied");
          toast?.showToast({ kind: "success", message: `${label} copied.` });
          return;
        }
      } catch {
        // Keep the field selected for manual copying.
      }
      setFeedback("Selected");
      toast?.showToast({ kind: "info", message: `${label} selected. Press Ctrl+C to copy.` });
    }
  };

  return <button className="copy-action" type="button" disabled={!value} onClick={() => void copy()} aria-label={`Copy ${label}`}>{feedback || "Copy"}</button>;
}

function Metric({ label, help, value, detail, warning = false }: { label: string; help?: string; value: string; detail: string; warning?: boolean }) {
  return (
    <div className={warning ? "metric warning" : "metric"}>
      <span>{label}{help && <HelpTip label={label} content={help} />}</span><strong>{value}</strong><small>{detail}</small>
    </div>
  );
}

function InfoLine({ label, help, value, mono = false }: { label: string; help?: string; value: string; mono?: boolean }) {
  return (
    <div className="info-line"><span>{label}{help && <HelpTip label={label} content={help} placement="right" />}</span><code className={mono ? "" : "plain"}>{value}</code></div>
  );
}

function StreamFact({ label, help, value, warning = false }: { label: string; help?: string; value: string; warning?: boolean }) {
  return (
    <div className={warning ? "stream-fact warning" : "stream-fact"}>
      <span>{label}{help && <HelpTip label={label} content={help} />}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FieldTitle({ children, help }: { children: ReactNode; help: string }) {
  return <span className="field-title">{children}<HelpTip label={String(children)} content={help} placement="left" /></span>;
}

function StreamIdle({ title, detail }: { title: string; detail: string }) {
  return <div className="stream-idle"><strong>{title}</strong><p>{detail}</p></div>;
}

function MediaTracks({ direction, tracks, previewStats }: {
  direction: "input" | "output";
  tracks: Track[];
  previewStats?: PreviewStats | null;
}) {
  if (!tracks.length) {
    return <div className="empty-state stream-empty">{direction === "input" ? "Track details appear when an input is online." : "Output track details appear when browser-ready media is published."}</div>;
  }

  const groups = (["video", "audio", "unknown"] as const).map((kind) => ({
    kind,
    tracks: tracks.filter((track) => trackKind(track) === kind),
  })).filter((group) => group.tracks.length > 0);

  return (
    <div className="media-domains">
      {groups.map((group) => (
        <section className="media-domain" key={group.kind}>
          <div className="media-domain-heading">
            <span>{group.kind === "unknown" ? "OTHER" : group.kind.toUpperCase()}</span>
            <small>{group.tracks.length} {group.tracks.length === 1 ? "track" : "tracks"}</small>
          </div>
          {direction === "output" && group.kind !== "unknown" && <ReceiverDetails
            kind={group.kind}
            receiver={group.kind === "video" ? previewStats?.video : previewStats?.audio}
          />}
          {group.tracks.map((track, index) => (
            <MediaTrack
              key={`${track.codec}-${index}`}
              track={track}
              kind={group.kind}
              direction={direction}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function MediaTrack({ track, kind, direction }: {
  track: Track;
  kind: "video" | "audio" | "unknown";
  direction: "input" | "output";
}) {
  const facts: Array<{ label: string; value: string }> = [];
  if (kind === "video") {
    facts.push(
      { label: "Resolution", value: formatResolution(undefined, undefined, track) },
      { label: "Frame rate", value: formatFrameRate(undefined, track) },
      { label: "Profile", value: stringTrackProperty(track, "profile") || "Not reported" },
    );
    const level = stringTrackProperty(track, "level");
    if (level) facts.push({ label: "Level", value: level });
  } else if (kind === "audio") {
    facts.push(
      { label: "Sample rate", value: formatSampleRate(numberTrackProperty(track, "sampleRate")) },
      { label: "Channels", value: formatChannels(numberTrackProperty(track, "channelCount")) },
    );
  } else {
    facts.push({ label: "Metadata", value: formatTrack(track) });
  }

  return (
    <div className="media-track">
      <div className="media-track-heading">
        <span>{kind === "video" ? "VID" : kind === "audio" ? "AUD" : "DAT"}</span>
        <div><strong>{track.codec}</strong><small>{direction === "input" ? "Detected at ingest" : "Published to viewers"}</small></div>
      </div>
      <div className="media-fact-grid">
        {facts.map((fact) => <MediaFact key={fact.label} label={fact.label} value={fact.value} />)}
      </div>
    </div>
  );
}

function ReceiverDetails({ kind, receiver }: {
  kind: "video" | "audio";
  receiver?: ReceiverStats | VideoReceiverStats;
}) {
  if (!receiver) {
    return <div className="media-receiver idle"><span>BROWSER RECEIVER</span><p>Preview telemetry is waiting for this media track.</p></div>;
  }

  const facts = [
    { label: "Primary codec", value: receiver.codec },
    { label: "Receive bitrate", value: formatBitrate(receiver.bitrateBps) },
    { label: "Network", value: `${receiver.packetsLost} lost · ${receiver.jitterMs.toFixed(1)} ms jitter` },
  ];
  if (kind === "video") {
    const video = receiver as VideoReceiverStats;
    facts.splice(1, 0,
      { label: "Decoded resolution", value: video.width && video.height ? `${video.width} × ${video.height}` : "Not reported" },
      { label: "Decoded frame rate", value: video.framesPerSecond ? `${video.framesPerSecond.toFixed(video.framesPerSecond % 1 === 0 ? 0 : 1)} fps` : "Not reported" },
    );
    facts.push({ label: "Frames", value: `${video.framesDecoded} decoded · ${video.framesDropped} dropped` });
  }

  return (
    <div className="media-receiver">
      <span>BROWSER RECEIVER · {kind === "video" ? "VIDEO" : "AUDIO"} AGGREGATE</span>
      <div className="media-fact-grid">
        {facts.map((fact) => <MediaFact key={fact.label} label={fact.label} value={fact.value} />)}
      </div>
    </div>
  );
}

function MediaFact({ label, value }: { label: string; value: string }) {
  const help = mediaFactHelp(label);
  return <div className="media-fact"><span>{label}{help && <HelpTip label={label} content={help} />}</span><strong>{value}</strong></div>;
}

function connectionHelp(label: string) {
  if (label.includes("SRT URL")) return "Complete SRT caller URL for the encoder, including the selected Gateway host, channel port, and latency.";
  if (label === "Destination IP") return "Gateway media address the encoder should send to. It follows the active global media interface.";
  if (label === "Destination port") return "Per-channel UDP listener used by SRT push senders.";
  if (label === "SRT mode") return "Caller means the encoder initiates the SRT connection to Gateway.";
  if (label.includes("stream-ID URL")) return "Alternative shared SRT endpoint for MPEG-TS senders that support MediaMTX stream IDs.";
  if (label.includes("Viewer URL")) return "Standalone multiview link that plays every ready channel simultaneously.";
  if (label.toLowerCase().includes("embed url")) return "Channel-only, transparent video route using the channel's persistent number.";
  if (label === "Iframe embed code") return "Transparent, control-free video for placing this channel directly inside another page.";
  if (label === "WHEP API endpoint") return "Low-level WebRTC-HTTP egress endpoint used by compatible players.";
  return "";
}

function mediaFactHelp(label: string) {
  if (label.includes("bitrate")) return "Recent media rate calculated from successive byte counters.";
  if (label === "Network") return "Packet loss and jitter reported by this browser's WebRTC receiver.";
  if (label.includes("frame rate")) return "Frames decoded or reported per second for the video track.";
  if (label === "Frames") return "Cumulative frames decoded and dropped by this browser during the current preview session.";
  if (label === "Profile" || label === "Level") return "H264 compatibility parameters reported by the source track.";
  if (label === "Primary codec") return "Codec negotiated for this browser's active receiver.";
  return "";
}

function formatTrack(track: Track) {
  if (!track.codecProps) return "media track";
  const props = Object.entries(track.codecProps)
    .filter(([, value]) => value !== null && value !== "" && value !== 0)
    .map(([key, value]) => `${key} ${value}`);
  return props.join(" · ") || "media track";
}

function numberTrackProperty(track: Track, key: string) {
  const value = track.codecProps?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringTrackProperty(track: Track, key: string) {
  const value = track.codecProps?.[key];
  return value === undefined || value === null ? "" : String(value);
}

function formatResolution(width: number | undefined, height: number | undefined, track: Track) {
  const resolvedWidth = width || numberTrackProperty(track, "width");
  const resolvedHeight = height || numberTrackProperty(track, "height");
  return resolvedWidth && resolvedHeight ? `${resolvedWidth} × ${resolvedHeight}` : "Not reported";
}

function formatFrameRate(value: number | undefined, track: Track) {
  const resolved = value || numberTrackProperty(track, "frameRate") || numberTrackProperty(track, "fps");
  if (resolved) return `${resolved.toFixed(resolved % 1 === 0 ? 0 : 1)} fps`;
  return "Not reported";
}

function formatSampleRate(value: number) {
  if (!value) return "Not reported";
  return value >= 1000 ? `${value / 1000} kHz` : `${value} Hz`;
}

function formatChannels(value: number) {
  if (!value) return "Not reported";
  if (value === 1) return "1 · mono";
  if (value === 2) return "2 · stereo";
  return String(value);
}

function previewTitle(state: WHEPPlayerState, automatic: boolean, live: boolean) {
  if (!automatic) return "Preview off";
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

function interfaceLabel(item: NetworkInterface) {
  return `${item.name} - ${item.address} (${item.family}${item.loopback ? ", loopback" : ""})`;
}

function bindingLabel(value: string, interfaces: NetworkInterface[]) {
  if (value === "*") return "All interfaces";
  if (value === "custom") return "Legacy custom addresses";
  const selected = parseInterfaceBinding(value);
  if (selected) {
    const matches = interfaces.filter((candidate) => candidate.name === selected.name && candidate.family === selected.family);
    if (matches.length > 1) return `Follow ${selected.name} ${selected.family} (multiple addresses; select a fixed address)`;
    return matches[0]
      ? `Follow ${selected.name} ${selected.family} - current ${matches[0].address}`
      : `Follow ${selected.name} ${selected.family} (unavailable)`;
  }
  const item = interfaces.find((candidate) => candidate.address === value);
  return item ? `Fixed ${value} (${item.name}, ${item.family})` : `Fixed ${value} (unavailable)`;
}

function listenerAddress(bindAddress: string, currentAddress: string, port: string, disableWhenBlank = false) {
  if (disableWhenBlank && !port) return "";
  if (bindAddress === "custom" && listenerPort(currentAddress) === port) return currentAddress;

  const currentHost = currentAddress.match(/^(.*):\d*$/)?.[1] ?? "";
  const host = bindAddress === "custom"
    ? currentHost
    : bindAddress === "*" || parseInterfaceBinding(bindAddress)
      ? ""
      : bindAddress.includes(":") ? `[${bindAddress.replace(/^\[|\]$/g, "")}]` : bindAddress;
  return `${host}:${port}`;
}

function bindingAddress(binding: BindingStatus | undefined, interfaces: NetworkInterface[]) {
  if (!binding) return "";
  return binding.resolvedAddress ?? resolveInterfaceBinding(binding.desiredAddress, interfaces);
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

class APIRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "APIRequestError";
    this.status = status;
  }
}

async function requestAPI(input: RequestInfo | URL, init: BoundedRequestInit = {}) {
  const { response, body: text } = await requestText(input, init);
  if (!text) return { response, body: undefined as unknown };
  try {
    return { response, body: JSON.parse(text) as unknown };
  } catch {
    return { response, body: text as unknown };
  }
}

function apiErrorMessage(body: unknown, status: number, fallback: string) {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  return `${fallback} (${status})`;
}

function statusErrorMessage(error: unknown) {
  if (isRequestTimeoutError(error)) return "Gateway status request timed out";
  return error instanceof Error && error.message ? error.message.replace(/[.]+$/, "") : "Gateway status is not responding";
}

function quoteRevision(revision: number) {
  return `"${revision}"`;
}

function isStatus(value: unknown): value is Status {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Status>;
  return Boolean(item.gateway && item.media && item.network && isGlobalSettings(item.settings)) &&
    Array.isArray(item.channels) && item.channels.every(isChannel);
}

function isGlobalSettings(value: unknown): value is GlobalSettings {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GlobalSettings>;
  return typeof item.revision === "number" && item.revision >= 1 &&
    typeof item.managementBindAddress === "string" && typeof item.mediaBindAddress === "string" &&
    typeof item.applyState === "string" && typeof item.updatedAt === "string" &&
    Array.isArray(item.webRTCAdditionalHosts);
}

function isChannel(value: unknown): value is Channel {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Channel>;
  return typeof item.id === "string" && typeof item.revision === "number" && item.revision >= 1 &&
    typeof item.name === "string" && typeof item.whepPath === "string" &&
    typeof item.enabled === "boolean" && typeof item.automaticPreview === "boolean" &&
    typeof item.outputReady === "boolean" && typeof item.applyState === "string" &&
    Boolean(item.input && typeof item.input.mode === "string") &&
    Boolean(item.compatibility && typeof item.compatibility.state === "string" && Array.isArray(item.compatibility.reasons)) &&
    Array.isArray(item.readers) && Array.isArray(item.tracks) && Array.isArray(item.outputTracks);
}

function isChannelPreference(value: unknown): value is Pick<Channel, "automaticPreview" | "revision" | "updatedAt"> {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Channel>;
  return typeof item.automaticPreview === "boolean" && typeof item.revision === "number" && typeof item.updatedAt === "string";
}

function isPassphraseResponse(value: unknown): value is { configured: boolean; passphrase: string; revision: number } {
  if (!value || typeof value !== "object") return false;
  const item = value as { configured?: unknown; passphrase?: unknown; revision?: unknown };
  return typeof item.configured === "boolean" && typeof item.passphrase === "string" && typeof item.revision === "number";
}
