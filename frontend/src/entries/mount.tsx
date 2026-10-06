import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "../Providers";

export function mount(page: ReactNode) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Providers>{page}</Providers>
    </StrictMode>,
  );
}
