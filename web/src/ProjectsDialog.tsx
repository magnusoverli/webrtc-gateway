import { useEffect, useId, useRef, useState } from "react";
import { ModalShell } from "./Modal";
import { requestJSON, requestWithDeadline } from "./request";
import { useToast } from "./Toast";

type ProjectSummary = {
  id: string;
  revision: number;
  name: string;
  channelCount: number;
  createdAt: string;
  updatedAt: string;
};

type LoadResult = {
  projectId: string;
  projectRevision: number;
  channelCount: number;
  managementRestartRequired: boolean;
};

export type ProjectsDialogProps = {
  mutationBlocked: boolean;
  onClose: () => void;
  onLoaded: (result: LoadResult) => void;
  onLoadIndeterminate: () => void;
};

export function ProjectsDialog({ mutationBlocked, onClose, onLoaded, onLoadIndeterminate }: ProjectsDialogProps) {
  const titleID = useId();
  const { showToast } = useToast();
  const requestRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState<{ action: "load" | "delete"; id: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const loadProjects = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const { response, body } = await requestJSON<unknown>("/api/v1/projects", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(apiMessage(body, "Unable to read projects"));
      const items = readProjects(body);
      if (!items) throw new Error("Gateway returned malformed project data");
      if (requestRef.current === controller) setProjects(items);
    } catch (caught) {
      if (!controller.signal.aborted && requestRef.current === controller) {
        setError(caught instanceof Error ? caught.message : "Unable to read projects");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadProjects();
    return () => requestRef.current?.abort();
  }, []);

  const saveCurrent = async () => {
    if (!name.trim() || mutationBlocked || busy) return;
    setBusy("save");
    setError("");
    try {
      const item = await mutateProject("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setProjects((current) => sortProjects([...current, item]));
      setName("");
      showToast({ kind: "success", message: `Project “${item.name}” saved.` });
    } catch (caught) {
      setError(errorMessage(caught));
      showToast({ kind: "error", message: "Project was not saved." });
    } finally {
      setBusy("");
    }
  };

  const renameProject = async (item: ProjectSummary) => {
    if (!renaming?.name.trim() || busy) return;
    setBusy(item.id);
    setError("");
    try {
      const updated = await mutateProject(`/api/v1/projects/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": quoteRevision(item.revision) },
        body: JSON.stringify({ name: renaming.name }),
      });
      setProjects((current) => sortProjects(current.map((candidate) => candidate.id === item.id ? updated : candidate)));
      setRenaming(null);
      showToast({ kind: "success", message: "Project renamed." });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const overwriteProject = async (item: ProjectSummary) => {
    if (mutationBlocked || busy) return;
    setBusy(item.id);
    setError("");
    try {
      const updated = await mutateProject(`/api/v1/projects/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": quoteRevision(item.revision) },
        body: JSON.stringify({ name: item.name }),
      });
      setProjects((current) => current.map((candidate) => candidate.id === item.id ? updated : candidate));
      showToast({ kind: "success", message: `Project “${item.name}” updated from the running configuration.` });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const loadProject = async (item: ProjectSummary) => {
    if (mutationBlocked || busy) return;
    setBusy(item.id);
    setError("");
    let responseReceived = false;
    try {
      const { response, body } = await requestJSON<unknown>(`/api/v1/projects/${encodeURIComponent(item.id)}/load`, {
        method: "POST",
        headers: { "If-Match": quoteRevision(item.revision) },
        timeoutMs: 30_000,
      });
      responseReceived = true;
      if (!response.ok) throw new Error(apiMessage(body, "Project load failed"));
      const result = readLoadResult(body);
      if (!result) throw new Error("Gateway returned a malformed project load result");
      setConfirming(null);
      showToast({ kind: "success", message: `Project “${item.name}” loaded.` });
      onLoaded(result);
    } catch (caught) {
      if (!responseReceived) {
        setError("The load request disconnected before Gateway reported a result. Its outcome is indeterminate; current status is being refreshed.");
        onLoadIndeterminate();
        showToast({ kind: "info", message: "Project load outcome is indeterminate. Refreshing Gateway status." });
      } else {
        setError(errorMessage(caught));
        showToast({ kind: "error", message: "Project was not loaded." });
      }
    } finally {
      setBusy("");
    }
  };

  const deleteProject = async (item: ProjectSummary) => {
    if (busy) return;
    setBusy(item.id);
    setError("");
    try {
      const { response, body } = await requestWithDeadline(`/api/v1/projects/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "If-Match": quoteRevision(item.revision) },
      }, async (value) => value.text());
      if (!response.ok) throw new Error(apiMessage(parseText(body), "Project deletion failed"));
      setProjects((current) => current.filter((candidate) => candidate.id !== item.id));
      setConfirming(null);
      showToast({ kind: "success", message: "Project deleted. The running configuration was not changed." });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const exportProject = async (item: ProjectSummary) => {
    if (busy) return;
    setBusy(item.id);
    setError("");
    try {
      const { response, body } = await requestWithDeadline(`/api/v1/projects/${encodeURIComponent(item.id)}/export`, {}, (value) => value.blob());
      if (!response.ok) throw new Error("Project export failed");
      const objectURL = URL.createObjectURL(body);
      const anchor = document.createElement("a");
      anchor.href = objectURL;
      anchor.download = `${safeFilename(item.name)}.json`;
      anchor.click();
      URL.revokeObjectURL(objectURL);
      showToast({ kind: "info", message: "Sensitive project file exported with SRT passphrases." });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const importProject = async (file: File) => {
    if (busy) return;
    setBusy("import");
    setError("");
    try {
      const { response, body } = await requestJSON<unknown>("/api/v1/projects/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: file,
        timeoutMs: 30_000,
      });
      if (!response.ok) throw new Error(apiMessage(body, "Project import failed"));
      const item = readProject(body);
      if (!item) throw new Error("Gateway returned malformed imported project data");
      setProjects((current) => sortProjects([...current, item]));
      showToast({ kind: "success", message: `Project “${item.name}” imported without changing the running configuration.` });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
      setBusy("");
    }
  };

  return (
    <ModalShell labelledBy={titleID} className="projects-dialog" closeLabel="Close projects" onClose={onClose} dismissDisabled={Boolean(busy)}>
      <header className="projects-header">
        <div>
          <span className="eyebrow">CONFIGURATION LIBRARY</span>
          <h2 id={titleID}>Projects</h2>
          <p>Save or restore the complete Gateway setup. Exported files contain plaintext SRT passphrases and must be handled as sensitive.</p>
        </div>
      </header>

      <div className="projects-body">
        <section className="project-save" aria-labelledby="project-save-heading">
          <div>
            <h3 id="project-save-heading">Save running configuration</h3>
            <p>Creates a snapshot without changing channels, listeners, or viewers.</p>
          </div>
          <div className="project-save-controls">
            <label><span>Project name</span><input value={name} maxLength={80} disabled={Boolean(busy) || mutationBlocked} onChange={(event) => setName(event.target.value)} /></label>
            <button className="button primary" type="button" disabled={!name.trim() || Boolean(busy) || mutationBlocked} onClick={() => void saveCurrent()}>{busy === "save" ? "Saving..." : "Save current"}</button>
          </div>
        </section>

        {error && <div className="editor-alert" role="alert"><strong>Project operation failed.</strong> {error}</div>}
        {loading && <div className="projects-state" role="status">Loading projects...</div>}
        {!loading && projects.length === 0 && <div className="projects-state"><strong>No saved projects</strong><span>Save the running configuration or import a project file.</span></div>}
        {!loading && projects.length > 0 && <div className="project-list">
          {projects.map((item) => {
            const confirmation = confirming?.id === item.id ? confirming.action : null;
            return <article className="project-row" key={item.id}>
              <div className="project-row-main">
                {renaming?.id === item.id ? <div className="project-rename">
                  <input aria-label={`New name for ${item.name}`} value={renaming.name} maxLength={80} disabled={busy === item.id} onChange={(event) => setRenaming({ id: item.id, name: event.target.value })} />
                  <button className="button primary" type="button" disabled={!renaming.name.trim() || busy === item.id} onClick={() => void renameProject(item)}>Save name</button>
                  <button className="button secondary" type="button" disabled={busy === item.id} onClick={() => setRenaming(null)}>Cancel</button>
                </div> : <>
                  <strong>{item.name}</strong>
                  <span>{item.channelCount} {item.channelCount === 1 ? "channel" : "channels"} · Updated <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time></span>
                </>}
              </div>
              {confirmation ? <div className="project-confirm" role="group" aria-label={`Confirm ${confirmation} project ${item.name}`}>
                <p>{confirmation === "load" ? "Replace the complete running configuration? Active viewers and inputs may be interrupted. Automatic rollback runs if application fails." : "Delete this saved snapshot? The running configuration is unaffected."}</p>
                <button className={confirmation === "delete" ? "button danger" : "button primary"} type="button" disabled={busy === item.id || mutationBlocked && confirmation === "load"} onClick={() => void (confirmation === "load" ? loadProject(item) : deleteProject(item))}>{busy === item.id ? "Working..." : `Confirm ${confirmation}`}</button>
                <button className="button secondary" type="button" disabled={busy === item.id} onClick={() => setConfirming(null)}>Cancel</button>
              </div> : <div className="project-actions">
                <button className="button primary" type="button" disabled={Boolean(busy) || mutationBlocked} onClick={() => setConfirming({ action: "load", id: item.id })}>Load</button>
                <button className="button secondary" type="button" disabled={Boolean(busy) || mutationBlocked} onClick={() => void overwriteProject(item)}>Update</button>
                <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => setRenaming({ id: item.id, name: item.name })}>Rename</button>
                <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void exportProject(item)}>Export</button>
                <button className="button danger ghost-danger" type="button" disabled={Boolean(busy)} onClick={() => setConfirming({ action: "delete", id: item.id })}>Delete</button>
              </div>}
            </article>;
          })}
        </div>}
      </div>

      <footer className="projects-footer">
        <input ref={fileRef} className="visually-hidden" type="file" accept="application/json,.json" disabled={Boolean(busy)} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importProject(file);
        }} />
        <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>{busy === "import" ? "Importing..." : "Import project"}</button>
        <span>Import stores a project without loading it.</span>
        <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={onClose}>Close</button>
      </footer>
    </ModalShell>
  );
}

async function mutateProject(url: string, init: RequestInit) {
  const { response, body } = await requestJSON<unknown>(url, init);
  if (!response.ok) throw new Error(apiMessage(body, "Project request failed"));
  const item = readProject(body);
  if (!item) throw new Error("Gateway returned malformed project data");
  return item;
}

function readProjects(value: unknown): ProjectSummary[] | null {
  if (!isRecord(value) || !Array.isArray(value.projects)) return null;
  const projects = value.projects.map(readProject);
  return projects.every((item): item is ProjectSummary => item !== null) ? projects : null;
}

function readProject(value: unknown): ProjectSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
      typeof value.revision !== "number" || typeof value.channelCount !== "number" ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  return {
    id: value.id, name: value.name, revision: value.revision, channelCount: value.channelCount,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function readLoadResult(value: unknown): LoadResult | null {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.projectRevision !== "number" ||
      typeof value.channelCount !== "number" || typeof value.managementRestartRequired !== "boolean") return null;
  return {
    projectId: value.projectId, projectRevision: value.projectRevision, channelCount: value.channelCount,
    managementRestartRequired: value.managementRestartRequired,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiMessage(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback;
  if (typeof value.error === "string") return value.error;
  if (isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
  return fallback;
}

function parseText(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function quoteRevision(value: number) { return `"${value}"`; }
function errorMessage(value: unknown) { return value instanceof Error ? value.message : "Project operation failed"; }
function safeFilename(value: string) { return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "gateway-project"; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(); }
function sortProjects(items: ProjectSummary[]) { return [...items].sort((left, right) => left.name.localeCompare(right.name)); }
