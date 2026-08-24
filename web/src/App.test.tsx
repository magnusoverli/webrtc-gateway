// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, ResourceFooter } from "./App";
import { railCollapsedKey } from "./uiPreferences";

describe("dashboard rail", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        media: "(max-width: 900px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("collapses navigation accessibly and persists the desktop preference", async () => {
    const user = userEvent.setup();
    render(<App />);
    const collapse = screen.getByRole("button", { name: "Collapse gateway navigation" });
    const navigation = document.getElementById("gateway-navigation");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(navigation?.hasAttribute("hidden")).toBe(false);

    await user.click(collapse);
    expect(screen.getByRole("button", { name: "Expand gateway navigation" }).getAttribute("aria-expanded")).toBe("false");
    expect(navigation?.hasAttribute("hidden")).toBe(true);
    await waitFor(() => expect(window.localStorage.getItem(railCollapsedKey)).toBe("true"));
  });

  it("starts expanded on mobile without overwriting the desktop preference", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(railCollapsedKey, "true");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        media: "(max-width: 900px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    render(<App />);
    expect(screen.getByRole("button", { name: "Collapse gateway navigation" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Collapse gateway navigation" }));
    expect(screen.getByRole("button", { name: "Expand gateway navigation" })).toBeDefined();
    expect(window.localStorage.getItem(railCollapsedKey)).toBe("true");
  });

  it("marks retained resource values stale when status polling is disconnected", () => {
    render(<ResourceFooter disconnected resources={{
      sampledAt: "2026-08-24T12:00:00Z",
      gateway: {
        status: "ok", scope: "gateway-cgroup",
        cpu: { percent: 12.5, usedCores: 1, capacityCores: 8 },
        memory: { usedBytes: 512 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 * 1024 },
      },
      host: {
        status: "ok", scope: "host",
        cpu: { percent: 25, usedCores: 2, capacityCores: 8 },
        memory: { usedBytes: 4 * 1024 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 * 1024 },
      },
      media: { status: "unavailable", scope: "mediamtx-cgroup", errorCode: "isolated_scope" },
    }} />);
    expect(screen.getAllByText("STALE")).toHaveLength(3);
    expect(screen.getByText("512 MiB / 8.0 GiB")).toBeDefined();
    expect(screen.getByRole("progressbar", { name: "Gateway CPU utilization" })).toBeDefined();
    expect(screen.getByRole("progressbar", { name: "Host CPU utilization" })).toBeDefined();
  });

  it("marks resources unavailable when the first status request fails", () => {
    render(<ResourceFooter disconnected />);
    expect(screen.getAllByText("UNAVAILABLE")).toHaveLength(3);
    expect(screen.queryByText("LOADING")).toBeNull();
  });
});
