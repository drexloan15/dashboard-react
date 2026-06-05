"use client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import type { Printer, HistorialRow, PrStatsData, PrStatsUsuarioDetail, AlertaEstado, AlertasStatusMap, SolicitudSuministro } from "@/types";
import { parsePrinter } from "@/lib/utils";

// ── Estado actual ─────────────────────────────────────────────────────────────
export function useEstadoData() {
  return useQuery({
    queryKey: ["estado"],
    queryFn: async () => {
      const { data } = await axios.get<{ estado: Printer[]; ts: string }>("/api/py/estado");
      return { ...data, estado: data.estado.map(parsePrinter) as Printer[] };
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
}

// ── Historial reciente (overview / sedes / analíticas) ────────────────────────
export function useRecentHistorial(enabled: boolean, days = 30) {
  return useQuery({
    queryKey: ["historial-recent", days],
    enabled,
    queryFn: async () =>
      (await axios.get<{ historial: HistorialRow[]; ts: string }>(`/api/py/historial/recent?days=${days}`)).data,
    staleTime: 60_000,
  });
}

// ── Historial paginado (tabla Historial) ──────────────────────────────────────
export function useHistorialPage(params: URLSearchParams) {
  return useQuery({
    queryKey: ["historial-page", params.toString()],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (await axios.get<{ items: HistorialRow[]; total: number; page: number; page_size: number; total_pages: number }>(
        `/api/py/historial?${params.toString()}`
      )).data,
  });
}

// ── PR Stats ──────────────────────────────────────────────────────────────────
export function usePrStats(enabled: boolean) {
  return useQuery({
    queryKey: ["pr-stats"],
    enabled,
    queryFn: async () => (await axios.get<PrStatsData>("/api/py/pr_stats")).data,
    staleTime: 300_000,
  });
}

export function useUsuarioPrStats(userid: string | null) {
  return useQuery({
    queryKey: ["pr-stats-user", userid],
    enabled: Boolean(userid),
    queryFn: async () =>
      (await axios.get<PrStatsUsuarioDetail>(`/api/py/pr_stats/usuario/${encodeURIComponent(userid!)}`)).data,
    staleTime: 300_000,
  });
}

// ── Alertas: checks compartidos ───────────────────────────────────────────────

/** Polling cada 15 s → sincroniza checks entre PCs. */
export function useAlertasStatus() {
  return useQuery({
    queryKey: ["alertas-status"],
    queryFn: async () => (await axios.get<AlertasStatusMap>("/api/py/alertas/status")).data,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

/** Mutation con optimistic update para marcar / desmarcar checks. */
export function useAlertasMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, estado }: { key: string; estado: AlertaEstado | null }) => {
      if (estado === null) {
        await axios.delete(`/api/py/alertas/status/${encodeURIComponent(key)}`);
      } else {
        await axios.put(`/api/py/alertas/status/${encodeURIComponent(key)}`, { estado });
      }
    },
    onMutate: async ({ key, estado }) => {
      await qc.cancelQueries({ queryKey: ["alertas-status"] });
      const prev = qc.getQueryData<AlertasStatusMap>(["alertas-status"]);
      qc.setQueryData<AlertasStatusMap>(["alertas-status"], (old = {}) => {
        if (estado === null) {
          const next = { ...old };
          delete next[key];
          return next;
        }
        return { ...old, [key]: estado };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(["alertas-status"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["alertas-status"] }),
  });
}

/** Verifica el PIN contra el backend. */
export function useVerifyPin() {
  return useMutation({
    mutationFn: async (pin: string) => {
      const { data } = await axios.post<{ ok: boolean }>("/api/py/auth/pin", { pin });
      return data.ok;
    },
  });
}

// ── Solicitudes de Suministros ────────────────────────────────────────────────

/** Correo destinatario por defecto configurado en el servidor. */
export function useEmailConfig() {
  return useQuery({
    queryKey: ["email-config"],
    queryFn: async () => (await axios.get<{ email_to: string }>("/api/py/config/email")).data,
    staleTime: Infinity,
  });
}

/** Historial paginado de solicitudes enviadas. */
export function useSolicitudesHistory(page: number) {
  return useQuery({
    queryKey: ["solicitudes", page],
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (await axios.get<{
        items: SolicitudSuministro[];
        total: number;
        page: number;
        page_size: number;
        total_pages: number;
      }>(`/api/py/solicitudes?page=${page}&page_size=20`)).data,
    staleTime: 30_000,
  });
}

/** Envía una solicitud de suministros por correo y la guarda en BD. */
export function useSendSolicitud() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      printer_ip:    string;
      suministros:   string[];
      to_email:      string;
      notas:         string;
      reportado_por: string;
    }) => (await axios.post<{ ok: boolean; id: number }>("/api/py/solicitudes/enviar", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["solicitudes"] }),
  });
}
