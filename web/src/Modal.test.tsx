// @vitest-environment jsdom

import { createRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalShell } from "./Modal";

afterEach(cleanup);

describe("ModalShell", () => {
  it("renders an accessible labelled dialog and optional icon close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ModalShell labelledBy="modal-title" className="wide-editor" closeLabel="Close settings" onClose={onClose}>
        <h2 id="modal-title">Settings</h2>
      </ModalShell>,
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.className).toBe("editor wide-editor");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const close = screen.getByRole("button", { name: "Close settings" });
    expect(close.querySelector("svg")).not.toBeNull();
    expect(document.activeElement).toBe(close);
    await user.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("omits the close control when no close label is supplied", () => {
    render(
      <ModalShell labelledBy="modal-title" onClose={vi.fn()}>
        <h2 id="modal-title">Editor</h2>
        <input aria-label="Name" />
      </ModalShell>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
  });

  it("only dismisses an exact backdrop click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ModalShell labelledBy="modal-title" onClose={onClose}>
        <h2 id="modal-title">Editor</h2>
        <button type="button">Child</button>
      </ModalShell>,
    );

    await user.click(screen.getByRole("button", { name: "Child" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets a child consume Escape before handling it at the dialog", () => {
    const onClose = vi.fn();
    const childKeyDown = vi.fn((event: ReactKeyboardEvent) => event.stopPropagation());
    const outsideKeyDown = vi.fn();
    render(
      <div onKeyDown={outsideKeyDown}>
        <ModalShell labelledBy="modal-title" onClose={onClose}>
          <h2 id="modal-title">Editor</h2>
          <button type="button" onKeyDown={childKeyDown}>Tooltip trigger</button>
        </ModalShell>
      </div>,
    );

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    screen.getByRole("button", { name: "Tooltip trigger" }).dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
    expect(childKeyDown).toHaveBeenCalledOnce();
    expect(outsideKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables backdrop, Escape, and close-button dismissal", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ModalShell labelledBy="modal-title" closeLabel="Close" dismissDisabled onClose={onClose}>
        <h2 id="modal-title">Saving</h2>
        <button type="button">Action</button>
      </ModalShell>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    await user.click(close);
    await user.click(screen.getByRole("presentation"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Action" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("traps forward and backward Tab navigation", async () => {
    const user = userEvent.setup();
    render(
      <ModalShell labelledBy="modal-title" onClose={vi.fn()}>
        <h2 id="modal-title">Editor</h2>
        <button type="button" disabled>Disabled</button>
        <input aria-label="First" />
        <button type="button">Last</button>
      </ModalShell>,
    );

    const first = screen.getByRole("textbox", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(document.activeElement).toBe(first);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(first);
  });

  it("focuses the dialog when it has no focusable children", async () => {
    const user = userEvent.setup();
    render(
      <ModalShell labelledBy="modal-title" onClose={vi.fn()}>
        <h2 id="modal-title">Notice</h2>
      </ModalShell>,
    );

    const dialog = screen.getByRole("dialog", { name: "Notice" });
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(dialog);
  });

  it("restores prior focus on unmount and exposes the dialog ref", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const dialogRef = createRef<HTMLElement>();
    const view = render(
      <ModalShell ref={dialogRef} labelledBy="modal-title" onClose={vi.fn()}>
        <h2 id="modal-title">Editor</h2>
        <button type="button">Inside</button>
      </ModalShell>,
    );

    expect(dialogRef.current).toBe(screen.getByRole("dialog"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside" }));
    view.unmount();
    expect(dialogRef.current).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
