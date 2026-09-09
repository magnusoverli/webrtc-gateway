import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { Resizable, type ResizeCallbackData, type ResizeHandleAxis } from "react-resizable";
import "react-resizable/css/styles.css";
import { clampTileSize, type TileSize } from "./multiviewLayout";

const handles: ResizeHandleAxis[] = ["w", "e", "n", "s", "nw", "ne", "sw", "se"];
const labels = { w: "left edge", e: "right edge", n: "top edge", s: "bottom edge", nw: "top-left corner", ne: "top-right corner", sw: "bottom-left corner", se: "bottom-right corner" };

// react-resizable owns mouse/touch tracking, constraints and all eight handles.
// This adapter only translates its pixel sizes to our saved grid-relative units.
export function TileResizer({ children, nodeRef, name, size, disabled, onStart, onChange, onCommit, onCancel, onKeyboardResize }: {
  children: ReactElement; nodeRef: RefObject<HTMLElement | null>; name: string; size: TileSize; disabled: boolean;
  onStart: () => boolean; onChange: (size: TileSize) => void; onCommit: (size: TileSize) => void; onCancel: () => void; onKeyboardResize: (size: TileSize) => void;
}) {
  const [metrics, setMetrics] = useState({ stepX: 1, stepY: 1, gapX: 0, gapY: 0 });
  const [handlesEnabled, setHandlesEnabled] = useState(true);
  const active = useRef(false);
  const callbacks = useRef({ onCancel });
  callbacks.current = { onCancel };

  const cancel = () => {
    if (!active.current) return;
    active.current = false;
    callbacks.current.onCancel();
    // Unmount only the library's handle controllers to release document-level
    // listeners and selection locks. The article/video stays mounted throughout.
    setHandlesEnabled(false);
  };
  useEffect(() => { if (!handlesEnabled) setHandlesEnabled(true); }, [handlesEnabled]);

  useLayoutEffect(() => {
    const grid = nodeRef.current?.closest<HTMLElement>(".multiview-grid");
    if (!grid) return;
    const measure = () => {
      const rect = grid.getBoundingClientRect(), style = getComputedStyle(grid);
      if (!rect.width || !rect.height) return;
      const gapX = parseFloat(style.columnGap) || 0, gapY = parseFloat(style.rowGap) || 0;
      setMetrics({ stepX: (rect.width + gapX) / 4, stepY: (rect.height + gapY) / 3, gapX, gapY });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(grid);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [nodeRef]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && active.current) { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    document.addEventListener("touchcancel", cancel, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("touchcancel", cancel, true);
    };
  }, []);

  const fromPixels = (data: ResizeCallbackData) => clampTileSize({
    columns: (data.size.width + metrics.gapX) / metrics.stepX,
    rows: (data.size.height + metrics.gapY) / metrics.stepY,
  });
  return <Resizable width={size.columns * metrics.stepX - metrics.gapX} height={size.rows * metrics.stepY - metrics.gapY}
    minConstraints={[metrics.stepX - metrics.gapX, metrics.stepY - metrics.gapY]}
    maxConstraints={[4 * metrics.stepX - metrics.gapX, 3 * metrics.stepY - metrics.gapY]}
    resizeHandles={handlesEnabled && !disabled ? handles : []}
    draggableOpts={{ disabled }}
    onResizeStart={() => { active.current = onStart(); }}
    onResize={(_, data) => { if (active.current) onChange(fromPixels(data)); }}
    onResizeStop={(_, data) => { if (!active.current) return; active.current = false; onCommit(fromPixels(data)); }}
    // Keep the stock grip visuals. Cardinal edges get an invisible full-length
    // target so hovering anywhere along an edge offers the expected resize cursor.
    handle={(axis, ref) => <span ref={ref} role="button" tabIndex={0}
      className={axis.length === 1 ? `multiview-edge-hitarea multiview-edge-hitarea-${axis}` : `react-resizable-handle react-resizable-handle-${axis}`}
      aria-label={`Resize ${name} ${labels[axis]}`} aria-describedby="multiview-help"
      title="Drag to resize; arrow keys adjust, Shift+arrow adjusts a whole cell"
      onKeyDown={(event) => {
        if (active.current || disabled) return;
        const x = axis !== "n" && axis !== "s" ? event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0 : 0;
        const y = axis !== "e" && axis !== "w" ? event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0 : 0;
        if (!x && !y) return;
        event.preventDefault();
        const step = event.shiftKey ? 1 : 0.1;
        onKeyboardResize(clampTileSize({ columns: size.columns + x * step * (axis.includes("w") ? -1 : 1), rows: size.rows + y * step * (axis.includes("n") ? -1 : 1) }));
      }}>{axis.length === 1 && <span className={`react-resizable-handle react-resizable-handle-${axis}`} aria-hidden="true" />}</span>}>{children}</Resizable>;
}
