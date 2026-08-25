import { useMemo, type ReactNode, type RefObject } from "react";
import { channelPlaybackReady, channelStateLabel, channelTone, type Channel, type ChannelStreamRates, type ChannelTone } from "./channel";
import { GridIcon, ListIcon, PlusIcon, SettingsIcon } from "./Icons";
import { formatBitrate, inputModeLabel } from "./presentation";
import { useWHEPPlayer } from "./useWHEPPlayer";

export type OverviewFilter = "all" | "live" | "fault" | "idle";
export type OverviewLayout = "grid" | "list";

type Props = {
  channels: Channel[];
  loading: boolean;
  error: string;
  rates: Record<string, ChannelStreamRates>;
  query: string;
  filter: OverviewFilter;
  layout: OverviewLayout;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: OverviewFilter) => void;
  onLayoutChange: (layout: OverviewLayout) => void;
  onSelect: (id: string) => void;
  onEdit: (item: Channel) => void;
  previewSavingIDs: ReadonlySet<string>;
  onAutomaticPreviewChange: (item: Channel, enabled: boolean) => void;
  onCreate: () => void;
  onRetry: () => void;
  mutationsDisabled?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
};

const filters: OverviewFilter[] = ["all", "live", "fault", "idle"];
const layouts: OverviewLayout[] = ["grid", "list"];

export function ChannelOverview({
  channels,
  loading,
  error,
  rates,
  query,
  filter,
  layout,
  onQueryChange,
  onFilterChange,
  onLayoutChange,
  onSelect,
  onEdit,
  previewSavingIDs,
  onAutomaticPreviewChange,
  onCreate,
  onRetry,
  mutationsDisabled = false,
  headingRef,
}: Props) {
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return channels.filter((item) => {
      const matchesQuery = !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery);
      return matchesQuery && (filter === "all" || channelTone(item) === filter);
    });
  }, [channels, filter, query]);

  if (loading && !error) {
    return (
      <OverviewState headingRef={headingRef}>
        <p className="empty-state" role="status">Loading channels...</p>
      </OverviewState>
    );
  }

  if (error && channels.length === 0) {
    return (
      <OverviewState headingRef={headingRef}>
        <div className="blank-state" role="alert">
          <span>CHANNELS UNAVAILABLE</span>
          <h2>Unable to load channels</h2>
          <p>Gateway status is not responding. Check the connection and try again.</p>
          <button className="button primary" type="button" onClick={onRetry}>Retry</button>
        </div>
      </OverviewState>
    );
  }

  if (channels.length === 0) {
    return (
      <section className="blank-state" aria-labelledby="empty-channels-title">
        <h1 id="channel-overview-title" className="visually-hidden" ref={headingRef} tabIndex={-1}>Channels</h1>
        <span>NO CHANNELS</span>
        <h2 id="empty-channels-title">No channels configured</h2>
        <p>Create an RTP or SRT channel to begin routing media.</p>
        <button className="button primary" type="button" onClick={onCreate} disabled={mutationsDisabled}>
          <PlusIcon aria-hidden="true" />
          Create channel
        </button>
      </section>
    );
  }

  return (
    <section className="overview" aria-labelledby="channel-overview-title">
      <div className="overview-heading">
        <div>
          <span className="eyebrow">Overview</span>
          <h1 id="channel-overview-title" ref={headingRef} tabIndex={-1}>Channels</h1>
        </div>
        <button className="button primary" type="button" onClick={onCreate} disabled={mutationsDisabled}>
          <PlusIcon aria-hidden="true" />
          Add channel
        </button>
      </div>
      <p className="overview-subtitle">Live status, rates and viewers for every configured input.</p>
      {error && <div className="overview-stale"><span>Showing last known channel state. Gateway polling will retry automatically.</span><button className="button secondary" type="button" onClick={onRetry}>Retry now</button></div>}

      <div className="overview-controls">
        <input
          className="overview-search"
          type="search"
          aria-label="Search channels"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search channels"
        />
        <div className="overview-filters" role="group" aria-label="Filter channels">
          {filters.map((key) => (
            <button
              key={key}
              type="button"
              className={filter === key ? `overview-chip active-${key}` : "overview-chip"}
              aria-pressed={filter === key}
              onClick={() => onFilterChange(key)}
            >
              {labelFor(key)}
            </button>
          ))}
        </div>
        <div className="overview-layout-toggle" role="group" aria-label="Channel layout">
          {layouts.map((key) => (
            <button
              key={key}
              type="button"
              className={layout === key ? "active" : ""}
              aria-label={`${labelFor(key)} view`}
              aria-pressed={layout === key}
              title={`${labelFor(key)} view`}
              onClick={() => onLayoutChange(key)}
            >
              {key === "grid" ? <GridIcon aria-hidden="true" /> : <ListIcon aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="empty-state">{emptyFilterCopy(query, filter)}</p>
      ) : (
        <div className={layout === "grid" ? "overview-grid" : "overview-list"}>
          {filtered.map((item) => {
            const tone = error ? "idle" : channelTone(item);
            return <OverviewCard
              key={item.id}
              item={item}
              tone={tone}
              rate={rates[item.id]}
              layout={layout}
              stale={Boolean(error)}
              mutationsDisabled={mutationsDisabled}
              previewSaving={previewSavingIDs.has(item.id)}
              onSelect={onSelect}
              onEdit={onEdit}
              onAutomaticPreviewChange={onAutomaticPreviewChange}
            />;
          })}
        </div>
      )}
    </section>
  );
}

function OverviewCard({ item, tone, rate, layout, stale, mutationsDisabled, previewSaving, onSelect, onEdit, onAutomaticPreviewChange }: {
  item: Channel;
  tone: ChannelTone;
  rate?: ChannelStreamRates;
  layout: OverviewLayout;
  stale: boolean;
  mutationsDisabled: boolean;
  previewSaving: boolean;
  onSelect: (id: string) => void;
  onEdit: (item: Channel) => void;
  onAutomaticPreviewChange: (item: Channel, enabled: boolean) => void;
}) {
  const showPreview = layout === "grid";
  const previewEnabled = showPreview && item.automaticPreview && channelPlaybackReady(item);
  const preview = useWHEPPlayer({ whepPath: item.whepPath, enabled: previewEnabled, retry: true });
  const previewStatus = overviewPreviewStatus(item, stale, preview.state, preview.hasVideo, preview.hasAudio);

  return (
    <article className={`overview-card tone-${tone}`}>
      <button className="overview-card-hitbox" type="button" aria-label={`Open details for ${item.name}`} onClick={() => onSelect(item.id)} />
      <div className="overview-card-head">
        <span className={`signal ${tone === "live" ? "online" : tone === "fault" ? "fault" : ""}`} />
        <div className="overview-card-title"><strong>{item.name}</strong><small>{inputModeLabel(item.input.mode)}</small></div>
        <button type="button" className="overview-card-edit" aria-label={`Configure ${item.name}`} title="Configure channel" disabled={mutationsDisabled} onClick={() => onEdit(item)}>
          <SettingsIcon aria-hidden="true" />
        </button>
      </div>
      {showPreview && (
        <div className={`overview-thumb preview-${preview.state}${preview.state === "playing" ? " interactive" : ""}`} role="group" aria-label={`${item.name} preview: ${previewStatus}`}>
          <video
            ref={preview.videoRef}
            autoPlay
            playsInline
            muted
            controls={preview.state === "playing"}
            controlsList="nodownload noplaybackrate"
            aria-label={`${item.name} muted preview`}
          />
          {!(preview.state === "playing" && preview.hasVideo) && (
            <span className={preview.state === "error" ? "overview-preview-message error" : "overview-preview-message"}>{previewStatus}</span>
          )}
        </div>
      )}
      <div className="overview-card-stats">
        <div><span>Input</span><strong>{item.available && item.online ? formatBitrate(rate?.inputBitrateBps) : "—"}</strong></div>
        <div><span>Output</span><strong>{item.outputReady ? formatBitrate(rate?.outputBitrateBps) : "—"}</strong></div>
        <div><span>Viewers</span><strong>{item.outputReady ? item.readers.length : "—"}</strong></div>
      </div>
      <div className="overview-card-foot">
        <span className={`overview-state tone-${tone}`}>{stale ? "Status stale" : channelStateLabel(item)}</span>
        {showPreview && <div className="overview-preview-control">
          <span>Preview</span>
          <button
            className={item.automaticPreview ? "toggle active overview-preview-toggle" : "toggle overview-preview-toggle"}
            type="button"
            disabled={previewSaving || item.applyState === "deleting" || stale || mutationsDisabled}
            aria-label={`${item.automaticPreview ? "Disable" : "Enable"} preview for ${item.name}`}
            aria-pressed={item.automaticPreview}
            title="Show a muted live preview for this channel"
            onClick={() => onAutomaticPreviewChange(item, !item.automaticPreview)}
          ><span /></button>
        </div>}
      </div>
    </article>
  );
}

function overviewPreviewStatus(item: Channel, stale: boolean, state: ReturnType<typeof useWHEPPlayer>["state"], hasVideo: boolean, hasAudio: boolean) {
  if (!item.automaticPreview) return "Preview off";
  if (stale) return "Status stale";
  if (!item.enabled) return "Channel disabled";
  if (item.applyState === "deleting") return "Deletion pending";
  if (!item.outputReady) return item.available && item.online ? "Preparing output" : "Waiting for input";
  if (state === "connecting") return "Connecting";
  if (state === "error") return "Preview unavailable";
  if (state === "playing" && !hasVideo) return hasAudio ? "Audio only" : "Connected";
  return "Muted live preview";
}

function OverviewState({ children, headingRef }: { children: ReactNode; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  return (
    <section className="overview" aria-labelledby="channel-overview-title">
      <div className="overview-heading">
        <div>
          <span className="eyebrow">Overview</span>
          <h1 id="channel-overview-title" ref={headingRef} tabIndex={-1}>Channels</h1>
        </div>
      </div>
      {children}
    </section>
  );
}

function emptyFilterCopy(query: string, filter: OverviewFilter) {
  const normalizedQuery = query.trim();
  if (normalizedQuery) return `No channels match "${normalizedQuery}".`;
  return `No channels match the ${filter} filter.`;
}

function labelFor(value: OverviewFilter | OverviewLayout) {
  return value[0].toUpperCase() + value.slice(1);
}
