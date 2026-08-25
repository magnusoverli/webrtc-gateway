import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "right" | "bottom" | "left";

export type TooltipTriggerProps = {
  ref: (node: HTMLElement | null) => void;
  "aria-describedby"?: string;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onClick?: (event: MouseEvent) => void;
};

export function Tooltip({ content, children, placement = "top", clickToOpen = false }: {
  content: ReactNode;
  children: (props: TooltipTriggerProps) => ReactNode;
  placement?: Placement;
  clickToOpen?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const triggerHovered = useRef(false);
  const triggerFocused = useRef(false);
  const tooltipHovered = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: -10_000, left: -10_000, ready: false });

  const cancelClose = () => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const show = () => {
    cancelClose();
    if (!open) setPosition((current) => ({ ...current, ready: false }));
    setOpen(true);
  };
  const hide = () => {
    cancelClose();
    setOpen(false);
  };
  const scheduleHide = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (!triggerHovered.current && !triggerFocused.current && !tooltipHovered.current) hide();
    }, 90);
  };

  useEffect(() => () => cancelClose(), []);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const next = placeTooltip(trigger.getBoundingClientRect(), tooltip.getBoundingClientRect(), placement);
      setPosition((current) => current.top === next.top && current.left === next.left && current.ready === next.ready ? current : next);
    };
    update();
    let animationFrame: number | undefined;
    const scheduleUpdate = () => {
      if (animationFrame !== undefined) return;
      if (typeof window.requestAnimationFrame !== "function") {
        update();
        return;
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = undefined;
        update();
      });
    };
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleUpdate) : undefined;
    if (resizeObserver) {
      let current: HTMLElement | null = triggerRef.current;
      while (current) {
        resizeObserver.observe(current);
        current = current.parentElement;
      }
      if (tooltipRef.current) resizeObserver.observe(tooltipRef.current);
    }
    const mutationObserver = typeof MutationObserver === "function" ? new MutationObserver((records) => {
      if (records.some((record) => record.target !== tooltipRef.current || record.attributeName !== "style")) scheduleUpdate();
    }) : undefined;
    if (mutationObserver && document.body) {
      mutationObserver.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
    }
    const fonts = document.fonts;
    fonts?.addEventListener("loadingdone", scheduleUpdate);
    let activeMotions = 0;
    let motionFrame: number | undefined;
    const trackMotion = () => {
      update();
      if (activeMotions > 0) motionFrame = window.requestAnimationFrame(trackMotion);
      else motionFrame = undefined;
    };
    const motionStarted = () => {
      activeMotions += 1;
      if (motionFrame === undefined) motionFrame = window.requestAnimationFrame(trackMotion);
    };
    const motionEnded = () => {
      activeMotions = Math.max(0, activeMotions - 1);
    };
    document.addEventListener("transitionrun", motionStarted, true);
    document.addEventListener("transitionend", motionEnded, true);
    document.addEventListener("transitioncancel", motionEnded, true);
    document.addEventListener("animationstart", motionStarted, true);
    document.addEventListener("animationend", motionEnded, true);
    document.addEventListener("animationcancel", motionEnded, true);
    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      fonts?.removeEventListener("loadingdone", scheduleUpdate);
      document.removeEventListener("transitionrun", motionStarted, true);
      document.removeEventListener("transitionend", motionEnded, true);
      document.removeEventListener("transitioncancel", motionEnded, true);
      document.removeEventListener("animationstart", motionStarted, true);
      document.removeEventListener("animationend", motionEnded, true);
      document.removeEventListener("animationcancel", motionEnded, true);
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      if (motionFrame !== undefined) window.cancelAnimationFrame(motionFrame);
    };
  }, [open, placement]);

  useEffect(() => {
    if (!open || !clickToOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !tooltipRef.current?.contains(target)) hide();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [clickToOpen, open]);

  const triggerProps: TooltipTriggerProps = {
    ref: (node) => { triggerRef.current = node; },
    "aria-describedby": open ? id : undefined,
    onPointerEnter: () => {
      triggerHovered.current = true;
      show();
    },
    onPointerLeave: () => {
      triggerHovered.current = false;
      scheduleHide();
    },
    onFocus: () => {
      triggerFocused.current = true;
      show();
    },
    onBlur: () => {
      triggerFocused.current = false;
      scheduleHide();
    },
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        if (open) event.stopPropagation();
        hide();
      } else if (clickToOpen && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        show();
      }
    },
    ...(clickToOpen ? { onClick: (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      show();
    } } : {}),
  };

  return <>
    {children(triggerProps)}
    {open && createPortal(
      <div
        id={id}
        ref={tooltipRef}
        className="tooltip"
        role="tooltip"
        style={{ top: position.top, left: position.left, visibility: position.ready ? "visible" : "hidden" }}
        onPointerEnter={() => {
          tooltipHovered.current = true;
          cancelClose();
        }}
        onPointerLeave={() => {
          tooltipHovered.current = false;
          scheduleHide();
        }}
      >{content}</div>,
      document.body,
    )}
  </>;
}

export function HelpTip({ label, content, placement = "top" }: {
  label: string;
  content: ReactNode;
  placement?: Placement;
}) {
  return (
    <Tooltip content={content} placement={placement} clickToOpen>
      {(props) => <span {...props} className="help-tip" role="button" tabIndex={0} aria-label={`Help: ${label}`}>?</span>}
    </Tooltip>
  );
}

function placeTooltip(trigger: DOMRect, tooltip: DOMRect, preferred: Placement) {
  const gap = 9;
  const margin = 8;
  const candidates = [preferred, opposite(preferred), "bottom", "top", "right", "left"] as Placement[];
  for (const placement of [...new Set(candidates)]) {
    const point = positionFor(trigger, tooltip, placement, gap);
    if (point.left >= margin && point.top >= margin &&
      point.left + tooltip.width <= window.innerWidth - margin &&
      point.top + tooltip.height <= window.innerHeight - margin) {
      return { ...point, ready: true };
    }
  }
  const point = positionFor(trigger, tooltip, preferred, gap);
  return {
    left: Math.max(margin, Math.min(point.left, window.innerWidth - tooltip.width - margin)),
    top: Math.max(margin, Math.min(point.top, window.innerHeight - tooltip.height - margin)),
    ready: true,
  };
}

function positionFor(trigger: DOMRect, tooltip: DOMRect, placement: Placement, gap: number) {
  if (placement === "right") return { left: trigger.right + gap, top: trigger.top + (trigger.height - tooltip.height) / 2 };
  if (placement === "bottom") return { left: trigger.left + (trigger.width - tooltip.width) / 2, top: trigger.bottom + gap };
  if (placement === "left") return { left: trigger.left - tooltip.width - gap, top: trigger.top + (trigger.height - tooltip.height) / 2 };
  return { left: trigger.left + (trigger.width - tooltip.width) / 2, top: trigger.top - tooltip.height - gap };
}

function opposite(placement: Placement): Placement {
  if (placement === "top") return "bottom";
  if (placement === "bottom") return "top";
  if (placement === "left") return "right";
  return "left";
}
