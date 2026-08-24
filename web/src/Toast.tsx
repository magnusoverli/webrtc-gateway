import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ToastKind = "success" | "info" | "error";

export type ToastOptions = {
  kind: ToastKind;
  message: ReactNode;
  timeout?: number;
};

type ToastState = ToastOptions & { id: number };
type ToastContextValue = { showToast: (toast: ToastOptions) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children, timeout = 2_500 }: {
  children: ReactNode;
  timeout?: number;
}) {
  const nextId = useRef(0);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = (nextToast: ToastOptions) => {
    setToast({ ...nextToast, id: ++nextId.current });
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      setToast((current) => current?.id === toast.id ? null : current);
    }, toast.timeout ?? timeout);
    return () => window.clearTimeout(timer);
  }, [toast, timeout]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        className="toast-viewport"
        aria-atomic="true"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "2rem",
          zIndex: 1000,
          transform: "translateX(-50%)",
          pointerEvents: "none",
        }}
      >
        {toast && (
          <div
            className={`toast toast-${toast.kind}`}
            role={toast.kind === "error" ? "alert" : "status"}
            aria-live={toast.kind === "error" ? undefined : "polite"}
          >
            {toast.message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within a ToastProvider");
  return context;
}

export function useOptionalToast() {
  return useContext(ToastContext);
}
