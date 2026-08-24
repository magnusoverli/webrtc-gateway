// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpTip, Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  afterEach(cleanup);

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
});
