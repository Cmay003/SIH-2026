import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api/client";
import type { MeResponse } from "../api/types";

/** Who is signed in. A 401 here means not signed in (handled by the page). */
export function useMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiGet<MeResponse>("/api/auth/me"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/api/auth/logout"),
    // Leave even if the request failed - the user asked to be signed out.
    onSettled: () => window.location.replace("/login.html?loggedout=1"),
  });
}
