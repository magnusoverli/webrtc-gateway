import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

type IconFrameProps = IconProps & { children: ReactNode };

function IconFrame({ children, className, "aria-hidden": ariaHidden = true, focusable = false, ...props }: IconFrameProps) {
  return (
    <svg
      aria-hidden={ariaHidden}
      className={className}
      fill="none"
      focusable={focusable}
      height="1em"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="1em"
      {...props}
    >
      {children}
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M12 5v14M5 12h14" /></IconFrame>;
}

export function GridIcon(props: IconProps) {
  return <IconFrame {...props}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></IconFrame>;
}

export function ListIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></IconFrame>;
}

export function SettingsIcon(props: IconProps) {
  return <IconFrame {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-1.5-1H2.5V10h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 4.2l.06.06A1.7 1.7 0 0 0 8.5 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 18.9 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1 .99Z" /></IconFrame>;
}

export const GearIcon = SettingsIcon;

export function ArrowLeftIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m19 12-14 0M11 18l-6-6 6-6" /></IconFrame>;
}

export function ArrowRightIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M5 12h14M13 6l6 6-6 6" /></IconFrame>;
}

export function ChevronLeftIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m15 18-6-6 6-6" /></IconFrame>;
}

export function ChevronRightIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m9 18 6-6-6-6" /></IconFrame>;
}

export function CloseIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M6 6l12 12M18 6 6 18" /></IconFrame>;
}

export function CopyIcon(props: IconProps) {
  return <IconFrame {...props}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></IconFrame>;
}

export function OpenIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></IconFrame>;
}
