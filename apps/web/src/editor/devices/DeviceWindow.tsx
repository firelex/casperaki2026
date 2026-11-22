import { useRef, useState, type ReactNode } from 'react';

/**
 * A floating device window (as a DAW opens a plugin): stays over the
 * editor without blocking it, dragged by its title bar, closed with ✕.
 */
export function DeviceWindow({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose(): void; children: ReactNode }) {
  const [pos, setPos] = useState(() => ({ x: Math.max(16, window.innerWidth / 2 - 380), y: 96 }));
  const drag = useRef<{ dx: number; dy: number } | undefined>(undefined);
  return (
    <div
      className="fixed z-[45] overflow-hidden rounded-[10px] border border-black/80 bg-[#16171a] shadow-[0_18px_50px_rgba(0,0,0,0.7)]"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`${title}, ${subtitle}`}
    >
      <div
        className="flex cursor-grab items-center gap-3 border-b border-black/70 bg-gradient-to-b from-[#3a3c42] to-[#2b2c31] px-3 py-1.5 active:cursor-grabbing"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPos({
            x: Math.max(0, Math.min(window.innerWidth - 120, e.clientX - drag.current.dx)),
            y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy)),
          });
        }}
        onPointerUp={(e) => {
          drag.current = undefined;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      >
        <span className="text-[12px] font-semibold text-white">{title}</span>
        <span className="text-[11px] text-[#a9aab1]">{subtitle}</span>
        <button type="button" onClick={onClose} className="ml-auto h-6 w-6 rounded-[4px] text-[13px] text-[#c4c5cb] hover:bg-white/10 hover:text-white" aria-label="Close">
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}
