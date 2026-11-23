import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";

interface PopoverProps {
  button: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  placement?: "up" | "down";
}

/** Anchored menu that closes on outside click or Escape. */
export function Popover({ button, children, align = "left", placement = "up" }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover-wrap" ref={ref}>
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div className={`popover popover-${placement} popover-${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="menu-section">
      {title && <div className="menu-title">{title}</div>}
      {children}
    </div>
  );
}

interface MenuItemProps {
  label: ReactNode;
  description?: string | null;
  selected?: boolean;
  icon?: ReactNode;
  onClick: () => void;
}

export function MenuItem({ label, description, selected, icon, onClick }: MenuItemProps) {
  return (
    <button className={`menu-item ${selected ? "selected" : ""}`} onClick={onClick}>
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="menu-text">
        <span>{label}</span>
        {description && <span className="menu-desc">{description}</span>}
      </span>
      <span className="menu-check">{selected && <Check size={14} />}</span>
    </button>
  );
}
