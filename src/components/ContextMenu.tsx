import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampMenuPosition } from "./code/codeHelpers";

export interface ContextMenuItem<Id extends string = string> {
  id: Id;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
}

export interface ContextMenuSection<Id extends string = string> {
  id: string;
  items: ContextMenuItem<Id>[];
}

export interface ContextMenuProps<Id extends string = string> {
  x: number;
  y: number;
  sections: ContextMenuSection<Id>[];
  onSelect: (id: Id) => void;
  onClose: () => void;
  ariaLabel?: string;
}

/** Floating right-click menu styled like `Popover`, clamped to the window
 *  with keyboard navigation and automatic close on outside click/Esc/scroll/blur. */
export default function ContextMenu<Id extends string = string>({
  x,
  y,
  sections,
  onSelect,
  onClose,
  ariaLabel = "컨텍스트 메뉴",
}: ContextMenuProps<Id>) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [activeId, setActiveId] = useState<Id | null>(null);

  const enabledItems = useMemo(
    () => sections.flatMap((s) => s.items).filter((item) => !item.disabled),
    [sections],
  );

  // Measure and clamp to the viewport before paint so the menu never flickers off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
  }, [x, y, sections]);

  // Focus the menu container on open so Arrow keys / Enter / Esc work immediately.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      onClose();
    };
    const onBlur = () => onClose();
    const onResize = () => onClose();

    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (enabledItems.length === 0) return;

    const currentIdx = activeId === null ? -1 : enabledItems.findIndex((item) => item.id === activeId);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % enabledItems.length;
      setActiveId(enabledItems[nextIdx].id);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const nextIdx =
        currentIdx < 0 ? enabledItems.length - 1 : (currentIdx - 1 + enabledItems.length) % enabledItems.length;
      setActiveId(enabledItems[nextIdx].id);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      setActiveId(enabledItems[0].id);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setActiveId(enabledItems[enabledItems.length - 1].id);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const target = currentIdx >= 0 ? enabledItems[currentIdx] : null;
      if (target) {
        onClose();
        onSelect(target.id);
      }
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sections.map((section) => (
        <div key={section.id} className="menu-section" role="group">
          {section.items.map((item) => {
            const isHighlighted = !item.disabled && activeId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                aria-disabled={item.disabled || undefined}
                className={`menu-item context-menu-item${isHighlighted ? " highlighted" : ""}${
                  item.danger ? " danger" : ""
                }`}
                onMouseEnter={() => {
                  if (!item.disabled) setActiveId(item.id);
                }}
                onMouseLeave={() => {
                  if (activeId === item.id) setActiveId(null);
                }}
                onClick={() => {
                  if (item.disabled) return;
                  onClose();
                  onSelect(item.id);
                }}
              >
                <span className="context-menu-label">{item.label}</span>
                {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>,
    document.body,
  );
}
