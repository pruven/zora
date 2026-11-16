"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

const MIN_WIDTH = 224;
const MAX_WIDTH = 420;
const STORAGE_KEY = "zora.sidebar-width";

export function useSidebarResize() {
  const [width, setWidth] = useState(248);
  const [maximum, setMaximum] = useState(MAX_WIDTH);
  const [resizing, setResizing] = useState(false);
  const preferred = useRef<number | null>(null);
  const currentWidth = useRef(248);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );

  function applyWidth(value: number, max = maximum) {
    const next = Math.round(Math.min(max, Math.max(MIN_WIDTH, value)));
    currentWidth.current = next;
    setWidth(next);
    return next;
  }

  function remember(value: number) {
    preferred.current = value;
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const value = saved === null ? NaN : Number(saved);
      if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH)
        preferred.current = value;
    } catch {
      // Use the responsive default when browser storage is unavailable.
    }
    const update = () => {
      const max = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, window.innerWidth - 560),
      );
      const fallback = window.innerWidth <= 1200 ? 224 : 248;
      const next = Math.round(
        Math.min(max, Math.max(MIN_WIDTH, preferred.current ?? fallback)),
      );
      setMaximum(max);
      currentWidth.current = next;
      setWidth(next);
      drag.current = null;
      setResizing(false);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const cursor = document.body.style.cursor;
    const selection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = selection;
    };
  }, [resizing]);

  function finish() {
    const start = drag.current;
    if (!start) return;
    drag.current = null;
    setResizing(false);
    if (currentWidth.current !== start.width) remember(currentWidth.current);
  }

  const handle = (
    <div
      className={`sidebar-resizer ${resizing ? "is-resizing" : ""}`}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-controls="workspace-sidebar"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maximum}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title="Drag to resize. Use arrow keys to adjust. Double-click to reset."
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: currentWidth.current,
        };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointerId !== event.pointerId) return;
        applyWidth(start.width + event.clientX - start.x);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        finish();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => {
        const fallback = window.innerWidth <= 1200 ? 224 : 248;
        preferred.current = null;
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Reset still restores responsive defaults without browser storage.
        }
        applyWidth(fallback);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 12;
        const target =
          event.key === "ArrowLeft"
            ? width - step
            : event.key === "ArrowRight"
              ? width + step
              : event.key === "Home"
                ? MIN_WIDTH
                : event.key === "End"
                  ? maximum
                  : null;
        if (target === null) return;
        event.preventDefault();
        remember(applyWidth(target));
      }}
    />
  );

  return {
    sidebarStyle: { "--sidebar-width": `${width}px` } as CSSProperties,
    resizeHandle: handle,
  };
}
