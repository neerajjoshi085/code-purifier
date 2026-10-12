import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

const OVERSCAN = 14;

/**
 * Windowed list for code: only the visible rows exist in the DOM, so a 100k-line
 * file scrolls as smoothly as a 100-line one. Rows have a fixed height.
 *
 * Imperative handle: { scrollToRow(i), setScroll(top, left), el }
 */
const VirtualCode = forwardRef(function VirtualCode({ count, rowHeight = 20, renderRow, onScroll, className = '', label }, ref) {
  const outer = useRef(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 60) });

  const measure = useCallback(() => {
    const el = outer.current;
    if (!el) return;
    const h = el.clientHeight || 480;
    const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - OVERSCAN);
    const end = Math.min(count, Math.ceil((el.scrollTop + h) / rowHeight) + OVERSCAN);
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [count, rowHeight]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const el = outer.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToRow(i, center = true) {
        const el = outer.current;
        if (!el) return;
        const target = center ? i * rowHeight - el.clientHeight / 2 + rowHeight : i * rowHeight;
        el.scrollTop = Math.max(0, target);
      },
      /**
       * Programmatic scroll (used by the synced compare view). Returns the scrollTop the browser
       * actually applied (it clamps at the ends), or null when nothing moved — in that case no
       * scroll event will follow.
       */
      setScroll(top, left) {
        const el = outer.current;
        if (!el) return null;
        const beforeTop = el.scrollTop;
        const beforeLeft = el.scrollLeft;
        el.scrollTop = top;
        if (left != null) el.scrollLeft = left;
        if (el.scrollTop === beforeTop && el.scrollLeft === beforeLeft) return null;
        measure(); // render the new rows in this frame, so the following pane never flashes blank
        return el.scrollTop;
      },
      get el() {
        return outer.current;
      },
    }),
    [rowHeight, measure],
  );

  const handleScroll = (e) => {
    measure(); // no-op unless the visible window changed
    onScroll?.(e.currentTarget.scrollTop, e.currentTarget.scrollLeft);
  };

  const rows = [];
  for (let i = range.start; i < Math.min(range.end, count); i++) rows.push(renderRow(i));

  return (
    <div ref={outer} className={`vc ${className}`} onScroll={handleScroll} role="region" aria-label={label} tabIndex={0}>
      <div className="vc__space" style={{ height: count * rowHeight }}>
        <div className="vc__rows" style={{ transform: `translateY(${range.start * rowHeight}px)` }}>
          {rows}
        </div>
      </div>
    </div>
  );
});

export default VirtualCode;
