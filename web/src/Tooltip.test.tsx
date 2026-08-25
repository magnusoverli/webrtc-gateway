// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpTip, Tooltip } from "./Tooltip";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

describe("Tooltip", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens from keyboard focus and closes with Escape", async () => {
    const user = userEvent.setup();
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><HelpTip label="CPU" content="Share of available CPU capacity." /></div>);
    const trigger = screen.getByRole("button", { name: "Help: CPU" });
    await user.tab();
    expect(document.activeElement).toBe(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Share of available CPU capacity.");
    expect(trigger.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(parentKeyDown).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(parentKeyDown).toHaveBeenCalledOnce();
  });

  it("supports pointer hover and delayed dismissal", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="RAM" content="Current working memory." />);
    const trigger = screen.getByRole("button", { name: "Help: RAM" });
    await user.hover(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Current working memory.");
    await user.unhover(trigger);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("does not replace the primary action of a wrapped control", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    render(
      <Tooltip content="Collapse navigation">
        {(props) => <button {...props} type="button" onClick={action}>Collapse</button>}
      </Tooltip>,
    );
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(action).toHaveBeenCalledOnce();
  });

  it("stays open while either focus or hover remains active", async () => {
    const user = userEvent.setup();
    render(<><HelpTip label="CPU" content="CPU details" /><button type="button">Next</button></>);
    const trigger = screen.getByRole("button", { name: "Help: CPU" });
    await user.hover(trigger);
    await user.tab();
    await user.unhover(trigger);
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    expect(screen.getByRole("tooltip")).toBeDefined();
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("opens on click and dismisses outside", async () => {
    const user = userEvent.setup();
    render(<><HelpTip label="CPU" content="CPU details" /><button type="button">Outside</button></>);
    await user.click(screen.getByRole("button", { name: "Help: CPU" }));
    expect(await screen.findByRole("tooltip")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("coalesces event-driven repositioning without scheduling a frame loop", async () => {
    const frames: FrameRequestCallback[] = [];
    let nextFrameId = 0;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return ++nextFrameId;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", undefined);
    let triggerLeft = 100;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip"
        ? rect(0, 0, 40, 20)
        : rect(triggerLeft, 100, 20, 20);
    });

    render(<Tooltip content="Positioned">{(props) => <button {...props} type="button">Trigger</button>}</Tooltip>);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Trigger" }));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.style.left).toBe("90px");
    expect(tooltip.style.top).toBe("71px");
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    triggerLeft = 180;
    fireEvent.scroll(window);
    fireEvent.resize(window);
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(tooltip.style.left).toBe("90px");

    act(() => frames.shift()?.(0));
    expect(tooltip.style.left).toBe("170px");
    expect(requestAnimationFrame).toHaveBeenCalledOnce();

    triggerLeft = 240;
    await act(async () => {
      document.body.setAttribute("data-layout-version", "1");
      await Promise.resolve();
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    act(() => frames.shift()?.(0));
    expect(tooltip.style.left).toBe("230px");
    document.body.removeAttribute("data-layout-version");
  });

  it("repositions for observed size changes and cleans up pending work", () => {
    const frames: FrameRequestCallback[] = [];
    let nextFrameId = 0;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return ++nextFrameId;
    });
    const cancelAnimationFrame = vi.fn();
    const observe = vi.fn();
    const disconnect = vi.fn();
    let notifyResize: ResizeObserverCallback | undefined;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    let tooltipWidth = 40;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip"
        ? rect(0, 0, tooltipWidth, 20)
        : rect(100, 100, 20, 20);
    });

    const view = render(<Tooltip content="Positioned">{(props) => <button {...props} type="button">Trigger</button>}</Tooltip>);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    fireEvent.pointerEnter(trigger);
    const tooltip = screen.getByRole("tooltip");
    expect(observe).toHaveBeenCalledWith(trigger);
    expect(observe).toHaveBeenCalledWith(tooltip);
    expect(tooltip.style.left).toBe("90px");

    tooltipWidth = 60;
    act(() => notifyResize?.([], {} as ResizeObserver));
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    act(() => frames.shift()?.(0));
    expect(tooltip.style.left).toBe("80px");

    fireEvent.resize(window);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    fireEvent.resize(window);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it("tracks trigger movement while a CSS transition is active", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", undefined);
    let triggerLeft = 100;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip"
        ? rect(0, 0, 40, 20)
        : rect(triggerLeft, 100, 20, 20);
    });

    render(<Tooltip content="Positioned">{(props) => <button {...props} type="button">Trigger</button>}</Tooltip>);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    fireEvent.pointerEnter(trigger);
    const tooltip = screen.getByRole("tooltip");
    fireEvent.transitionRun(trigger);
    triggerLeft = 160;
    act(() => frames.shift()?.(0));
    expect(tooltip.style.left).toBe("150px");

    triggerLeft = 220;
    act(() => frames.shift()?.(16));
    expect(tooltip.style.left).toBe("210px");
    fireEvent.transitionEnd(trigger);
    act(() => frames.shift()?.(32));
    expect(frames).toHaveLength(0);
  });
});
