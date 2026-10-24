import { useEffect, useLayoutEffect, useRef, useState } from 'react';

function scrollHost(target: HTMLElement): HTMLElement {
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (/(auto|scroll|overlay)/.test(overflow) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

function detailHeight(target: HTMLElement): number {
  if (target instanceof HTMLTableRowElement) {
    const next = target.nextElementSibling;
    return next?.matches('[data-testid$="history-details"]') ? next.getBoundingClientRect().height : 0;
  }
  return target.closest('article')?.querySelector('.withdrawal-detail, .custody-detail')?.getBoundingClientRect().height ?? 0;
}

/** Keeps the clicked row at the same viewport position when its detail is removed. */
export default function useStableDisclosureScroll(expandedRows: unknown) {
  const [reserveHeight, setReserveHeight] = useState(0);
  const pending = useRef<{ host: HTMLElement; target: HTMLElement; top: number } | null>(null);
  const hostWithReserve = useRef<HTMLElement | null>(null);

  const toggle = (target: HTMLElement, update: () => void) => {
    const host = scrollHost(target);
    hostWithReserve.current = host;
    pending.current = { host, target, top: target.getBoundingClientRect().top };

    if (target.getAttribute('aria-expanded') === 'true') {
      const remainingHeight = host.scrollHeight - detailHeight(target);
      const needed = Math.max(0, host.scrollTop + host.clientHeight - remainingHeight);
      if (needed > 0) setReserveHeight(current => current + needed);
    }
    update();
  };

  useLayoutEffect(() => {
    const anchor = pending.current;
    pending.current = null;
    if (!anchor?.target.isConnected) return;
    anchor.host.scrollTop += anchor.target.getBoundingClientRect().top - anchor.top;
  }, [expandedRows, reserveHeight]);

  useEffect(() => {
    const host = hostWithReserve.current;
    if (!host || reserveHeight === 0) return;
    const clearAtTop = () => { if (host.scrollTop <= 0) setReserveHeight(0); };
    host.addEventListener('scroll', clearAtTop, { passive: true });
    return () => host.removeEventListener('scroll', clearAtTop);
  }, [reserveHeight]);

  return { reserveHeight, toggle, clearReserve: () => setReserveHeight(0) };
}
