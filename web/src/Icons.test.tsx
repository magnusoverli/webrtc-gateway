// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OpenIcon, PlusIcon } from "./Icons";

describe("icons", () => {
  afterEach(cleanup);

  it("is decorative and unfocusable by default", () => {
    const { container } = render(<PlusIcon className="action-icon" />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
    expect(icon?.getAttribute("class")).toBe("action-icon");
  });

  it("can be exposed with an accessible label", () => {
    const { getByLabelText } = render(<OpenIcon aria-hidden={false} aria-label="Open channel" />);
    expect(getByLabelText("Open channel").tagName).toBe("svg");
  });
});
