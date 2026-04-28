"use client";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import type { Printer, HistorialRow } from "@/types";
import { parsePrinter } from "@/lib/utils";

interface ApiResponse {
  estado: Printer[];
  historial: HistorialRow[];
  ts: string;
}

async function fetchData(): Promise<ApiResponse> {
  const { data } = await axios.get<ApiResponse>("/api/py/data");
  return {
    ...data,
    estado: data.estado.map(parsePrinter) as Printer[],
  };
}

export function useData() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: fetchData,
    refetchInterval: 300_000,
    staleTime: 60_000,
  });
}
