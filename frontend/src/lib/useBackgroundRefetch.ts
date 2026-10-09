// Keeps an alarm-feeding query polling while the tab is in the background.
//
// refetchIntervalInBackground keeps TanStack Query's interval running while
// the tab is hidden, but that interval is a main-thread timer: once a tab has
// been hidden for ~5 minutes Chrome aligns such timers to once a minute, so a
// new HIGH hazard could alarm up to a minute late. A small dedicated worker
// (same origin, so the CSP's script-src 'self' allows it) ticks at the real
// rate and acts as a FALLBACK: on a tick while hidden it refetches only when
// TanStack's own interval has fallen behind (i.e. the page's timers are being
// throttled) and nothing is already in flight. That keeps it to one request
// per period, and a worker refetch never cancels a fetch already running.
// Returning to the tab is handled by refetchOnWindowFocus (Providers.tsx).
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export function useBackgroundRefetch(queryKey: QueryKey, ms: number): void {
  const queryClient = useQueryClient();
  // Keys are usually array literals: keep the latest without re-creating the worker
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;

  useEffect(() => {
    if (typeof Worker === "undefined" || typeof document === "undefined") return; // jsdom / very old browsers
    // cancelRefetch: false - join a fetch that is already running instead of
    // cancelling it (the default would cancel it, so on a link slower than
    // `ms` no fetch would ever complete while hidden).
    const refetch = () => {
      void queryClient.refetchQueries({ queryKey: keyRef.current, type: "active" }, { cancelRefetch: false });
    };
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("./bgTick.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = () => {
        if (!document.hidden) return;
        const st = queryClient.getQueryState(keyRef.current);
        if (st?.fetchStatus === "fetching") return; // a fetch is already in flight
        if (st && Date.now() - st.dataUpdatedAt < ms * 1.5) return; // TanStack's interval is keeping up
        refetch();
      };
      worker.postMessage(ms);
    } catch {
      worker = null; // workers blocked: TanStack's own interval still runs
    }
    return () => {
      worker?.terminate();
    };
  }, [queryClient, ms]);
}
