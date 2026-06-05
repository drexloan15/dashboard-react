"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/context/ThemeContext";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 300_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}
