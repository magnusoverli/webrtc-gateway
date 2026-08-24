import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { CloseIcon } from "./Icons";

export type ModalShellProps = {
  labelledBy: string;
  children: ReactNode;
  onClose: () => void;
  dismissDisabled?: boolean;
  className?: string;
  closeLabel?: string;
};

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.tabIndex < 0 || element.matches(":disabled") || element.hidden || element.closest("[hidden], [inert]")) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export const ModalShell = forwardRef<HTMLElement, ModalShellProps>(function ModalShell({
  labelledBy,
  children,
  onClose,
  dismissDisabled = false,
  className,
  closeLabel,
}, forwardedRef) {
  const dialogRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) (focusableElements(dialog)[0] ?? dialog).focus();

    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!dismissDisabled && event.target === event.currentTarget) onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!dismissDisabled) onClose();
      return;
    }

    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="editor-backdrop" role="presentation" onClick={handleBackdropClick}>
      <section
        ref={(node) => {
          dialogRef.current = node;
          setRef(forwardedRef, node);
        }}
        className={["editor", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {closeLabel && (
          <button
            className="icon-button"
            type="button"
            aria-label={closeLabel}
            disabled={dismissDisabled}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        )}
        {children}
      </section>
    </div>
  );
});
