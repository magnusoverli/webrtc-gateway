// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type ToastKind } from "./Toast";

function ToastControls() {
  const { showToast } = useToast();
  const show = (kind: ToastKind, message: string, timeout?: number) => {
    showToast({ kind, message, timeout });
  };

  return (
    <>
      <button type="button" onClick={() => show("success", "Saved")}>Success</button>
      <button type="button" onClick={() => show("info", "Working")}>Info</button>
      <button type="button" onClick={() => show("error", "Could not save")}>Error</button>
      <button type="button" onClick={() => show("info", "Brief", 100)}>Brief</button>
    </>
  );
}

describe("ToastProvider", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("displays a toast in the viewport", () => {
    render(<ToastProvider><ToastControls /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Success" }));

    expect(screen.getByText("Saved").closest(".toast-viewport")).not.toBeNull();
  });

  it("replaces the current toast with a newer one", () => {
    render(<ToastProvider><ToastControls /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Success" }));
    fireEvent.click(screen.getByRole("button", { name: "Info" }));

    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Working")).toBeDefined();
  });

  it("uses the appropriate live-region roles", () => {
    render(<ToastProvider><ToastControls /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");

    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    expect(screen.getByRole("alert").textContent).toBe("Could not save");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the toast after its timeout", () => {
    vi.useFakeTimers();
    render(<ToastProvider><ToastControls /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));

    act(() => vi.advanceTimersByTime(99));
    expect(screen.getByRole("status").textContent).toBe("Brief");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
