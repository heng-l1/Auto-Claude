import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { isWindows, isLinux } from '../../lib/os-detection';

interface TerminalContextMenuProps {
  /** Position to render the menu at, or null to hide */
  position: { x: number; y: number } | null;
  /** Called when the menu should close */
  onClose: () => void;
  /** Whether the terminal currently has a text selection */
  hasSelection: boolean;
  /** Copy the current terminal selection to clipboard */
  onCopy: () => void;
  /** Paste clipboard contents into the terminal */
  onPaste: () => void;
  /** Select all terminal content */
  onSelectAll: () => void;
  /** Clear the terminal */
  onClear: () => void;
}

/**
 * Context menu for terminal right-click actions.
 *
 * Rendered as a portal to avoid xterm container clipping.
 * Styled to match the Radix UI context menu appearance.
 * Supports Copy, Paste, Select All, and Clear Terminal actions
 * with platform-aware keyboard shortcut labels.
 */
export function TerminalContextMenu({
  position,
  onClose,
  hasSelection,
  onCopy,
  onPaste,
  onSelectAll,
  onClear,
}: TerminalContextMenuProps) {
  const { t } = useTranslation(['terminal']);
  const menuRef = useRef<HTMLDivElement>(null);
  const [clampedPos, setClampedPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Platform-aware modifier key
  const isMac = !isWindows() && !isLinux();
  const mod = isMac ? '\u2318' : 'Ctrl+';

  // Clamp menu position to viewport bounds after measuring
  useLayoutEffect(() => {
    if (!position || !menuRef.current) return;

    const menu = menuRef.current;
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const padding = 8;

    const x = Math.min(position.x, window.innerWidth - menuWidth - padding);
    const y = Math.min(position.y, window.innerHeight - menuHeight - padding);

    setClampedPos({
      x: Math.max(padding, x),
      y: Math.max(padding, y),
    });
  }, [position]);

  // Close on outside click
  useEffect(() => {
    if (!position) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [position, onClose]);

  // Close on Escape key
  useEffect(() => {
    if (!position) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [position, onClose]);

  const handleItemClick = useCallback(
    (action: () => void) => {
      action();
      onClose();
    },
    [onClose]
  );

  if (!position) return null;

  const menu = (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: clampedPos.x, top: clampedPos.y }}
    >
      {/* Copy */}
      <button
        type="button"
        className={cn(
          'flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground',
          !hasSelection && 'pointer-events-none opacity-50'
        )}
        disabled={!hasSelection}
        onClick={() => handleItemClick(onCopy)}
      >
        {t('terminal:contextMenu.copy')}
        <span className="ml-auto text-xs tracking-widest opacity-60">
          {mod}C
        </span>
      </button>

      {/* Paste */}
      <button
        type="button"
        className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
        onClick={() => handleItemClick(onPaste)}
      >
        {t('terminal:contextMenu.paste')}
        <span className="ml-auto text-xs tracking-widest opacity-60">
          {mod}V
        </span>
      </button>

      {/* Separator */}
      <div className="-mx-1 my-1 h-px bg-muted" />

      {/* Select All */}
      <button
        type="button"
        className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
        onClick={() => handleItemClick(onSelectAll)}
      >
        {t('terminal:contextMenu.selectAll')}
        <span className="ml-auto text-xs tracking-widest opacity-60">
          {mod}A
        </span>
      </button>

      {/* Clear Terminal */}
      <button
        type="button"
        className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
        onClick={() => handleItemClick(onClear)}
      >
        {t('terminal:contextMenu.clearTerminal')}
        <span className="ml-auto text-xs tracking-widest opacity-60">
          {mod}K
        </span>
      </button>
    </div>
  );

  return createPortal(menu, document.body);
}
