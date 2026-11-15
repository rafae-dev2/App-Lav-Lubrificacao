import { apoioClient, loadApoioData } from './apoioService';
import type { ApoioData } from '../types/apoio';

export const MAINTENANCE_READ_TIMEOUT_MS = 15_000;

/** Leitura consistente e sem escrita; mantém compatibilidade com instalação anterior. */
export async function loadMaintenanceData(): Promise<ApoioData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAINTENANCE_READ_TIMEOUT_MS);
  try {
    const { data, error } = await apoioClient
      .rpc('carregar_acompanhamento_manutencao')
      .abortSignal(controller.signal);
    // Somente ausência real da função permite fallback. Falhas de permissão,
    // rede ou schema não são mascaradas como sucesso em outra consulta.
    if (error?.code === 'PGRST202' || error?.code === '42883') {
      return await loadApoioData();
    }
    if (error) {
      if (controller.signal.aborted) throw new Error('[Manutenção] A consulta excedeu 15 segundos. Tente atualizar novamente.');
      throw new Error(`[Manutenção] Consulta compartilhada: ${error.message || error.code || 'erro desconhecido'}`);
    }
    if (!data || !Array.isArray(data.groups) || !Array.isArray(data.fleets) || !Array.isArray(data.orders)) {
      throw new Error('[Manutenção] Fotografia incompleta; a última seleção válida foi preservada.');
    }
    if (data.orders.some((row: unknown) => !row || typeof row !== 'object' || typeof (row as { chave?: unknown }).chave !== 'string' || typeof (row as { status?: unknown }).status !== 'string')) {
      throw new Error('[Manutenção] A fotografia contém ordens inconsistentes. Nenhum encerramento foi inferido desta resposta.');
    }
    return data as ApoioData;
  } finally {
    clearTimeout(timeout);
  }
}
