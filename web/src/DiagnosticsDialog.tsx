import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ModalShell } from "./Modal";
import { isRequestTimeoutError, requestJSON } from "./request";

const DIAGNOSTICS_TIMEOUT_MS = 8_000;

export type DiagnosticsScope = "system" | "channel";

export type DiagnosticsDialogProps = {
  scope: DiagnosticsScope;
  channelID?: string;
  channelName?: string;
  onClose: () => void;
};

type DiagnosticReader = { type: string; id: string };
type DiagnosticIssue = {
  code: string;
  source: string;
  severity: string;
  summary: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
};

type DiagnosticChannel = {
  id: string;
  number: number;
  name: string;
  path: string;
  enabled: boolean;
  revision: number;
  applyState: string;
  createdAt: string;
  updatedAt: string;
  runtime: {
    available: boolean;
    availableTime?: string;
    online: boolean;
    onlineTime?: string;
    outputAvailableTime?: string;
    source?: { type: string; id: string };
    readers: DiagnosticReader[];
  };
  outputReady: boolean;
  issues: DiagnosticIssue[];
  relay?: {
    state: string;
    restarts: number;
    lastError?: string;
    nextRetryAt?: string;
    listenerAddress?: string;
    listenerActive: boolean;
  };
  compatibility: {
    state: string;
    mode?: string;
    required: boolean;
    reasons: string[];
    lastError?: string;
    worker: { running: boolean; queued?: boolean; restarts: number; error?: string };
  };
};

type ResourceScope = {
  status: string;
  scope: string;
  errorCode?: string;
  sampledAt?: string;
  windowMs?: number;
  cpu: { percent: number | null; usedCores: number | null; capacityCores: number | null };
  memory: { usedBytes: number | null; currentBytes?: number; totalBytes: number | null };
};

type DiagnosticsResponse = {
  gateway: { version: string; startedAt: string };
  media: {
    reachable: boolean;
    version?: string;
    started?: string;
    error?: string;
    activeListeners?: { srt: string; webRTCUDP: string; webRTCTCP: string; rtmp?: string };
  };
  settings: { revision: number; applyState: string; updatedAt: string };
  resources?: {
    sampledAt: string;
    gateway: ResourceScope;
    host: ResourceScope;
    media: { status: string; scope: string; errorCode?: string };
  };
  channels: DiagnosticChannel[];
};

export function DiagnosticsDialog({ scope, channelID, channelName, onClose }: DiagnosticsDialogProps) {
  const titleID = useId();
  const requestRef = useRef<AbortController | null>(null);
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");

  const load = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setCopyState("idle");
    try {
      const { response, body } = await requestJSON<unknown>("/api/v1/diagnostics", {
        cache: "no-store",
        signal: controller.signal,
        timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
      });
      if (!response.ok) throw new DiagnosticsHTTPError(response.status);
      if (requestRef.current !== controller) return;
      setData(sanitizeDiagnostics(body));
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current !== controller) return;
      setData(null);
      setError(diagnosticsErrorMessage(caught));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, []);

  const selectedChannel = scope === "channel"
    ? data?.channels.find((item) => item.id === channelID)
    : undefined;
  const channelMissing = Boolean(scope === "channel" && data && !selectedChannel);
  const title = scope === "system"
    ? "System diagnostics"
    : `Channel diagnostics${channelName ? `: ${channelName}` : ""}`;
  const canCopy = Boolean(data && !loading && !error && !channelMissing);

  const copyReport = async () => {
    if (!data || !canCopy) return;
    setCopyState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      const report = scope === "system"
        ? data
        : { ...data, channels: selectedChannel ? [selectedChannel] : [] };
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <ModalShell
      labelledBy={titleID}
      className="diagnostics-dialog"
      closeLabel="Close diagnostics"
      onClose={onClose}
    >
      <header className="diagnostics-header">
        <div>
          <span className="eyebrow">On-demand snapshot</span>
          <h2 id={titleID}>{title}</h2>
          <p>Runtime and apply state only. Credentials and configuration payloads are excluded.</p>
        </div>
      </header>

      <div className="diagnostics-body">
        {loading && <div className="diagnostics-state" role="status">Loading diagnostics...</div>}
        {!loading && error && (
          <div className="diagnostics-state diagnostics-error" role="alert">
            <strong>Diagnostics unavailable</strong>
            <p>{error}</p>
            <button className="button secondary" type="button" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {!loading && !error && data && (
          <>
            <SystemSections data={data} />
            {scope === "system" && <ChannelInventory channels={data.channels} />}
            {scope === "channel" && selectedChannel && <ChannelSections channel={selectedChannel} />}
            {channelMissing && (
              <div className="diagnostics-state diagnostics-error" role="alert">
                <strong>Channel not found</strong>
                <p>The channel is not present in the current diagnostics snapshot.</p>
                <button className="button secondary" type="button" onClick={() => void load()}>Retry</button>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="diagnostics-footer">
        <span className={copyState === "error" ? "diagnostics-copy-state error" : "diagnostics-copy-state"} role="status" aria-live="polite">
          {copyState === "copied" ? "Report copied" : copyState === "error" ? "Copy failed" : ""}
        </span>
        <button className="button secondary" type="button" onClick={onClose}>Close</button>
        <button className="button primary" type="button" disabled={!canCopy || copyState === "copying"} onClick={() => void copyReport()}>
          {copyState === "copying" ? "Copying..." : "Copy diagnostic report"}
        </button>
      </footer>
    </ModalShell>
  );
}

function SystemSections({ data }: { data: DiagnosticsResponse }) {
  return (
    <section aria-labelledby="diagnostics-system-heading">
      <h3 id="diagnostics-system-heading" className="diagnostics-section-heading">System</h3>
      <div className="diagnostics-system-grid">
        <DiagnosticSection title="Gateway">
          <FactList facts={[
            ["Version", valueOrFallback(data.gateway.version)],
            ["Started", timestamp(data.gateway.startedAt)],
          ]} />
        </DiagnosticSection>
        <DiagnosticSection title="MediaMTX" tone={data.media.reachable ? undefined : "fault"}>
          <FactList facts={[
            ["Reachable", yesNo(data.media.reachable)],
            ["Version", valueOrFallback(data.media.version)],
            ["Started", timestamp(data.media.started)],
            ...(data.media.error ? [["Error", data.media.error] as [string, ReactNode]] : []),
          ]} />
        </DiagnosticSection>
        <DiagnosticSection title="Settings">
          <FactList facts={[
            ["Revision", data.settings.revision],
            ["Apply state", valueOrFallback(data.settings.applyState)],
            ["Updated", timestamp(data.settings.updatedAt)],
          ]} />
        </DiagnosticSection>
      </div>

      {data.media.activeListeners && (
        <details className="diagnostics-details">
          <summary>Active media listeners</summary>
          <FactList facts={[
            ["SRT", <code className="diagnostics-id">{valueOrFallback(data.media.activeListeners.srt)}</code>],
            ["WebRTC UDP", <code className="diagnostics-id">{valueOrFallback(data.media.activeListeners.webRTCUDP)}</code>],
            ["WebRTC TCP", <code className="diagnostics-id">{valueOrFallback(data.media.activeListeners.webRTCTCP)}</code>],
            ["Private RTMP", <code className="diagnostics-id">{valueOrFallback(data.media.activeListeners.rtmp)}</code>],
          ]} />
        </details>
      )}

      {data.resources && <ResourceDetails resources={data.resources} />}
    </section>
  );
}

function DiagnosticSection({ title, tone, children }: { title: string; tone?: "fault"; children: ReactNode }) {
  return (
    <section className={tone === "fault" ? "diagnostics-section fault" : "diagnostics-section"}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function FactList({ facts }: { facts: Array<[string, ReactNode]> }) {
  return (
    <dl className="diagnostics-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResourceDetails({ resources }: { resources: NonNullable<DiagnosticsResponse["resources"]> }) {
  return (
    <details className="diagnostics-details">
      <summary>Resource snapshot <small>{timestamp(resources.sampledAt)}</small></summary>
      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table">
          <caption>Resource availability and utilization</caption>
          <thead><tr><th scope="col">Scope</th><th scope="col">Status</th><th scope="col">CPU</th><th scope="col">Memory</th></tr></thead>
          <tbody>
            <ResourceRow label="Gateway" resource={resources.gateway} />
            <ResourceRow label="Host" resource={resources.host} />
            <tr>
              <th scope="row">MediaMTX</th>
              <td>{valueOrFallback(resources.media.status)}</td>
              <td colSpan={2}>{resources.media.errorCode ? `Unavailable (${resources.media.errorCode})` : "Not sampled separately"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ResourceRow({ label, resource }: { label: string; resource: ResourceScope }) {
  const cpu = resource.cpu.percent === null
    ? "-"
    : `${formatNumber(resource.cpu.percent)}%${resource.cpu.usedCores === null ? "" : ` · ${formatNumber(resource.cpu.usedCores)}/${formatNumber(resource.cpu.capacityCores ?? 0)} cores`}`;
  const memory = formatMemory(resource.memory.usedBytes, resource.memory.totalBytes);
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {valueOrFallback(resource.status)}{resource.errorCode ? ` (${resource.errorCode})` : ""}
        {(resource.sampledAt || resource.windowMs !== undefined) && <small>{timestampText(resource.sampledAt)}{resource.windowMs !== undefined ? ` · ${resource.windowMs} ms window` : ""}</small>}
      </td>
      <td>{cpu}</td>
      <td>{memory}{resource.memory.currentBytes !== undefined && <small>Current cgroup: {formatBytes(resource.memory.currentBytes)}</small>}</td>
    </tr>
  );
}

function ChannelInventory({ channels }: { channels: DiagnosticChannel[] }) {
  return (
    <section className="diagnostics-channel-section" aria-labelledby="diagnostics-channels-heading">
      <div className="diagnostics-heading-row">
        <h3 id="diagnostics-channels-heading" className="diagnostics-section-heading">Channels</h3>
        <span>{channels.length}</span>
      </div>
      {channels.length === 0 ? <p className="diagnostics-empty">No channels configured.</p> : (
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table diagnostics-channel-table">
            <caption>Configured channel diagnostics</caption>
            <thead><tr><th scope="col">Channel</th><th scope="col">Runtime</th><th scope="col">Output</th><th scope="col">Readers</th><th scope="col">Apply</th></tr></thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <th scope="row"><strong>{valueOrFallback(channel.name)}</strong><code className="diagnostics-id">{valueOrFallback(channel.id)}</code></th>
                  <td>{channel.enabled ? channel.runtime.online ? "Online" : "Offline" : "Disabled"}</td>
                  <td>{channel.outputReady ? "Ready" : "Not ready"}</td>
                  <td>{channel.runtime.readers.length}</td>
                  <td>{valueOrFallback(channel.applyState)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ChannelSections({ channel }: { channel: DiagnosticChannel }) {
  const source = channel.runtime.source;
  return (
    <section className="diagnostics-channel-section" aria-labelledby="diagnostics-channel-heading">
      <h3 id="diagnostics-channel-heading" className="diagnostics-section-heading">Selected channel</h3>
      <div className="diagnostics-channel-grid">
        <DiagnosticSection title="Configuration">
          <FactList facts={[
            ["Name", valueOrFallback(channel.name)],
            ["ID", <code className="diagnostics-id">{valueOrFallback(channel.id)}</code>],
            ["Path", <code className="diagnostics-id">{valueOrFallback(channel.path)}</code>],
            ["Number", channel.number],
            ["Enabled", yesNo(channel.enabled)],
            ["Revision", channel.revision],
            ["Apply state", valueOrFallback(channel.applyState)],
            ["Created", timestamp(channel.createdAt)],
            ["Updated", timestamp(channel.updatedAt)],
          ]} />
        </DiagnosticSection>
        <DiagnosticSection title="Runtime">
          <FactList facts={[
            ["Available", yesNo(channel.runtime.available)],
            ["Available since", timestamp(channel.runtime.availableTime)],
            ["Online", yesNo(channel.runtime.online)],
            ["Online since", timestamp(channel.runtime.onlineTime)],
            ["Output generation", timestamp(channel.runtime.outputAvailableTime)],
            ["Output ready", yesNo(channel.outputReady)],
            ["Readers", channel.runtime.readers.length],
            ["Source", source ? <><span>{valueOrFallback(source.type)}</span> <code className="diagnostics-id">{valueOrFallback(source.id)}</code></> : "-"],
          ]} />
        </DiagnosticSection>
        {channel.issues.length > 0 && (
          <DiagnosticSection title="Issues" tone="fault">
            <FactList facts={channel.issues.flatMap((issue) => [
              [issue.summary, issue.message] as [string, ReactNode],
              ["Code", <code className="diagnostics-id">{issue.code}</code>] as [string, ReactNode],
              ["Last seen", timestamp(issue.lastSeenAt)] as [string, ReactNode],
              ["Occurrences", issue.occurrences] as [string, ReactNode],
            ])} />
          </DiagnosticSection>
        )}
        <DiagnosticSection title="Compatibility" tone={channel.compatibility.state === "error" ? "fault" : undefined}>
          <FactList facts={[
            ["State", valueOrFallback(channel.compatibility.state)],
            ["Mode", valueOrFallback(channel.compatibility.mode)],
            ["Required", yesNo(channel.compatibility.required)],
            ["Worker", channel.compatibility.worker.running ? "Running" : channel.compatibility.worker.queued ? "Queued" : "Stopped"],
            ["Worker restarts", channel.compatibility.worker.restarts],
            ["Reasons", channel.compatibility.reasons.length ? channel.compatibility.reasons.join(", ") : "None"],
            ...(channel.compatibility.lastError ? [["Last error", channel.compatibility.lastError] as [string, ReactNode]] : []),
            ...(channel.compatibility.worker.error ? [["Worker error", channel.compatibility.worker.error] as [string, ReactNode]] : []),
          ]} />
        </DiagnosticSection>
        {channel.relay && (
          <DiagnosticSection title="SRT relay" tone={channel.relay.lastError ? "fault" : undefined}>
            <FactList facts={[
              ["State", valueOrFallback(channel.relay.state)],
              ["Restarts", channel.relay.restarts],
              ["Listener", <code className="diagnostics-id">{valueOrFallback(channel.relay.listenerAddress)}</code>],
              ["Listener active", yesNo(channel.relay.listenerActive)],
              ["Next retry", timestamp(channel.relay.nextRetryAt)],
              ...(channel.relay.lastError ? [["Last error", channel.relay.lastError] as [string, ReactNode]] : []),
            ]} />
          </DiagnosticSection>
        )}
      </div>

      {channel.runtime.readers.length > 0 && (
        <details className="diagnostics-details">
          <summary>Active readers <small>{channel.runtime.readers.length}</small></summary>
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <caption>Active channel readers</caption>
              <thead><tr><th scope="col">Type</th><th scope="col">ID</th></tr></thead>
              <tbody>{channel.runtime.readers.map((reader, index) => (
                <tr key={`${reader.type}:${reader.id}:${index}`}><td>{valueOrFallback(reader.type)}</td><td><code className="diagnostics-id">{valueOrFallback(reader.id)}</code></td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

class DiagnosticsHTTPError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Diagnostics request failed with HTTP ${status}.`);
    this.status = status;
  }
}

function diagnosticsErrorMessage(error: unknown) {
  if (isRequestTimeoutError(error)) return "The diagnostics request timed out. Check the Gateway connection and retry.";
  if (error instanceof DiagnosticsHTTPError) return error.message;
  return "The Gateway did not return a diagnostics snapshot. Check the connection and retry.";
}

function sanitizeDiagnostics(value: unknown): DiagnosticsResponse {
  const root = record(value);
  const gateway = record(root.gateway);
  const media = record(root.media);
  const settings = record(root.settings);
  const listeners = media.activeListeners === undefined ? undefined : record(media.activeListeners);
  const channels = Array.isArray(root.channels) ? root.channels.map(sanitizeChannel) : [];
  return {
    gateway: { version: stringValue(gateway.version), startedAt: stringValue(gateway.startedAt) },
    media: {
      reachable: booleanValue(media.reachable),
      version: optionalString(media.version),
      started: optionalString(media.started),
      error: optionalString(media.error),
      ...(listeners ? { activeListeners: {
        srt: stringValue(listeners.srt),
        webRTCUDP: stringValue(listeners.webRTCUDP),
        webRTCTCP: stringValue(listeners.webRTCTCP),
        rtmp: optionalString(listeners.rtmp),
      } } : {}),
    },
    settings: {
      revision: numberValue(settings.revision),
      applyState: stringValue(settings.applyState),
      updatedAt: stringValue(settings.updatedAt),
    },
    ...(root.resources === undefined ? {} : { resources: sanitizeResources(root.resources) }),
    channels,
  };
}

function sanitizeChannel(value: unknown): DiagnosticChannel {
  const item = record(value);
  const runtime = record(item.runtime);
  const source = runtime.source === undefined ? undefined : record(runtime.source);
  const relay = item.relay === undefined ? undefined : record(item.relay);
  const compatibility = record(item.compatibility);
  const worker = record(compatibility.worker);
  return {
    id: stringValue(item.id),
    number: numberValue(item.number),
    name: stringValue(item.name),
    path: stringValue(item.path),
    enabled: booleanValue(item.enabled),
    revision: numberValue(item.revision),
    applyState: stringValue(item.applyState),
    createdAt: stringValue(item.createdAt),
    updatedAt: stringValue(item.updatedAt),
    runtime: {
      available: booleanValue(runtime.available),
      availableTime: optionalString(runtime.availableTime),
      online: booleanValue(runtime.online),
      onlineTime: optionalString(runtime.onlineTime),
      outputAvailableTime: optionalString(runtime.outputAvailableTime),
      ...(source ? { source: { type: stringValue(source.type), id: stringValue(source.id) } } : {}),
      readers: sanitizeReaders(runtime.readers),
    },
    outputReady: booleanValue(item.outputReady),
    issues: sanitizeIssues(item.issues),
    ...(relay ? { relay: {
      state: stringValue(relay.state),
      restarts: numberValue(relay.restarts),
      lastError: optionalString(relay.lastError),
      nextRetryAt: optionalString(relay.nextRetryAt),
      listenerAddress: optionalString(relay.listenerAddress),
      listenerActive: booleanValue(relay.listenerActive),
    } } : {}),
    compatibility: {
      state: stringValue(compatibility.state),
      mode: optionalString(compatibility.mode),
      required: booleanValue(compatibility.required),
      reasons: Array.isArray(compatibility.reasons) ? compatibility.reasons.filter((reason): reason is string => typeof reason === "string") : [],
      lastError: optionalString(compatibility.lastError),
      worker: {
        running: booleanValue(worker.running),
        ...(typeof worker.queued === "boolean" ? { queued: worker.queued } : {}),
        restarts: numberValue(worker.restarts),
        error: optionalString(worker.error),
      },
    },
  };
}

function sanitizeIssues(value: unknown): DiagnosticIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const issue = record(candidate);
    return {
      code: stringValue(issue.code),
      source: stringValue(issue.source),
      severity: stringValue(issue.severity),
      summary: stringValue(issue.summary),
      message: stringValue(issue.message),
      firstSeenAt: stringValue(issue.firstSeenAt),
      lastSeenAt: stringValue(issue.lastSeenAt),
      occurrences: numberValue(issue.occurrences),
    };
  });
}

function sanitizeReaders(value: unknown): DiagnosticReader[] {
  if (!Array.isArray(value)) return [];
  return value.map((reader) => {
    const item = record(reader);
    return { type: stringValue(item.type), id: stringValue(item.id) };
  });
}

function sanitizeResources(value: unknown): NonNullable<DiagnosticsResponse["resources"]> {
  const resources = record(value);
  const media = record(resources.media);
  return {
    sampledAt: stringValue(resources.sampledAt),
    gateway: sanitizeResourceScope(resources.gateway),
    host: sanitizeResourceScope(resources.host),
    media: {
      status: stringValue(media.status),
      scope: stringValue(media.scope),
      errorCode: optionalString(media.errorCode),
    },
  };
}

function sanitizeResourceScope(value: unknown): ResourceScope {
  const resource = record(value);
  const cpu = record(resource.cpu);
  const memory = record(resource.memory);
  return {
    status: stringValue(resource.status),
    scope: stringValue(resource.scope),
    errorCode: optionalString(resource.errorCode),
    sampledAt: optionalString(resource.sampledAt),
    ...(typeof resource.windowMs === "number" && Number.isFinite(resource.windowMs) ? { windowMs: resource.windowMs } : {}),
    cpu: {
      percent: nullableNumber(cpu.percent),
      usedCores: nullableNumber(cpu.usedCores),
      capacityCores: nullableNumber(cpu.capacityCores),
    },
    memory: {
      usedBytes: nullableNumber(memory.usedBytes),
      ...(typeof memory.currentBytes === "number" && Number.isFinite(memory.currentBytes) ? { currentBytes: memory.currentBytes } : {}),
      totalBytes: nullableNumber(memory.totalBytes),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown) {
  return value === true;
}

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

function valueOrFallback(value: string | undefined) {
  return value || "-";
}

function timestamp(value: string | undefined) {
  return value ? <time dateTime={value}>{value}</time> : "-";
}

function timestampText(value: string | undefined) {
  return value || "Sample time unavailable";
}

function formatNumber(value: number) {
  return value.toFixed(value < 10 ? 1 : 0);
}

function formatMemory(used: number | null, total: number | null) {
  if (used === null) return "-";
  return total === null ? formatBytes(used) : `${formatBytes(used)} / ${formatBytes(total)}`;
}

function formatBytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : amount < 10 ? 1 : 0)} ${units[unit]}`;
}
