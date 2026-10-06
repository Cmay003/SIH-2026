import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import "./styles/global.css";

export function Providers({ children }: { children: ReactNode }) {
  // One client per page load; keep failed live-data requests from piling up
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
