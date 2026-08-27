// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsDialog } from "./ProjectsDialog";
import { ToastProvider } from "./Toast";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectsDialog", () => {
  it("lists saved projects and explains the secret-bearing snapshot model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ projects: [project()] })));

    renderDialog();

    expect(screen.getByRole("dialog", { name: "Projects" })).toBeDefined();
    expect(await screen.findByText("Studio baseline")).toBeDefined();
    expect(screen.getByText(/plaintext SRT passphrases/)).toBeDefined();
    expect(screen.getByText("2 channels", { exact: false })).toBeDefined();
  });

  it("saves the running configuration without loading it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [] }))
      .mockResolvedValueOnce(jsonResponse({ ...project(), name: "Event A" }, true, 201));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    await screen.findByText("No saved projects");
    await user.type(screen.getByLabelText("Project name"), "Event A");
    await user.click(screen.getByRole("button", { name: "Save current" }));

    expect(await screen.findByText("Event A")).toBeDefined();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/projects");
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
  });

  it("requires confirmation before replacing the running configuration", async () => {
    const user = userEvent.setup();
    const onLoaded = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [project()] }))
      .mockResolvedValueOnce(jsonResponse({
        projectId: "project-1", projectRevision: 3, channelCount: 2, managementRestartRequired: true,
      }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog({ onLoaded });

    await user.click(await screen.findByRole("button", { name: "Load" }));
    expect(screen.getByText(/Automatic rollback runs/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Confirm load" }));

    expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ managementRestartRequired: true }));
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.headers).toEqual(expect.objectContaining({ "If-Match": '"3"' }));
  });

  it("surfaces a failed load after the backend restores the previous configuration", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [project()] }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "project load failed and the previous configuration was restored: listener unavailable", rollbackSucceeded: true } }, false, 409));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Load" }));
    await user.click(screen.getByRole("button", { name: "Confirm load" }));

    expect(await screen.findByText(/previous configuration was restored: listener unavailable/)).toBeDefined();
  });
});

function renderDialog(overrides: Partial<ComponentProps<typeof ProjectsDialog>> = {}) {
  return render(<ToastProvider><ProjectsDialog mutationBlocked={false} onClose={vi.fn()} onLoaded={vi.fn()} onLoadIndeterminate={vi.fn()} {...overrides} /></ToastProvider>);
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function project() {
  return {
    id: "project-1",
    revision: 3,
    name: "Studio baseline",
    channelCount: 2,
    createdAt: "2026-08-27T10:00:00Z",
    updatedAt: "2026-08-27T11:00:00Z",
  };
}
