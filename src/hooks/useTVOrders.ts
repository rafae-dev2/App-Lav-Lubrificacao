import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApoioData } from '../types/apoio';
import { apoioClient, loadApoioData, loadApoioTVData, loadApoioVersion } from '../lib/apoioService';
import { APOIO_SNAPSHOT_MAX_AGE_MS, shouldCheckVersion, shouldReloadSnapshot, versionKey } from '../lib/apoioPolling';

export type TVConnection = 'connecting' | 'live' | 'polling' | 'offline';
export interface UseTVOrdersResult {
  /** Last complete snapshot; retained after read failures. */
  data: ApoioData | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  connection: TVConnection;
  /** Client read time; source time remains in data.sync.fonte_atualizada. */
  lastReadAt: string | null;
  refresh: () => Promise<void>;
}

/** Consulta de versão (~100 bytes). A fotografia completa só desce quando muda. */
const TV_POLL_MS = 30_000;
const TV_DEBOUNCE_MS = 1_000;
/** Tabela única que muda uma vez por sincronização, em vez de quatro tabelas. */
const TV_REALTIME_TABLE = 'apoio_sync';

function isBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Não foi possível ler o snapshot Apoio.';
}

/** Carga enxuta (somente ordens ativas). Se a leitura direta falhar, usa a RPC completa. */
async function loadTVSnapshot(): Promise<ApoioData> {
  try {
    return await loadApoioTVData();
  } catch {
    return loadApoioData();
  }
}

/** Read-only: never calls syncApoio or a write RPC. */
export function useTVOrders(): UseTVOrdersResult {
  const [data, setData] = useState<ApoioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<TVConnection>('connecting');
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const connectionRef = useRef<TVConnection>('connecting');
  const readInFlightRef = useRef<Promise<void> | null>(null);
  const versionInFlightRef = useRef<Promise<void> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRef = useRef<string | null>(null);
  const loadedAtRef = useRef<number | null>(null);
  const lastCheckRef = useRef<number | null>(null);

  const setConnectionState = useCallback((next: TVConnection) => {
    connectionRef.current = next;
    if (mountedRef.current) setConnection(next);
  }, []);

  const read = useCallback((mode: 'initial' | 'manual' | 'silent'): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    if (readInFlightRef.current) {
      if (mode === 'initial' && mountedRef.current) setLoading(true);
      if (mode === 'manual' && mountedRef.current) setRefreshing(true);
      return readInFlightRef.current.finally(() => {
        if (mode === 'manual' && mountedRef.current) setRefreshing(false);
      });
    }
    if (mountedRef.current) {
      if (mode === 'initial') setLoading(true);
      if (mode === 'manual') setRefreshing(true);
      // A leitura silenciosa não apaga um erro antes de confirmar uma nova
      // fotografia; o erro só é limpo no sucesso abaixo.
      if (mode !== 'silent') setError(null);
    }
    const operation = (async () => {
      try {
        const next = await loadTVSnapshot();
        if (!mountedRef.current) return;
        setData(next);
        setLastReadAt(new Date().toISOString());
        versionRef.current = versionKey(next.sync?.fonte_atualizada ?? null);
        loadedAtRef.current = Date.now();
        setError(null);
        if (connectionRef.current !== 'live') setConnectionState('polling');
      } catch (readError) {
        if (!mountedRef.current) return;
        // Preserve the last complete snapshot rather than clearing the TV.
        setError(errorMessage(readError));
        setConnectionState(isBrowserOnline() ? 'polling' : 'offline');
      } finally {
        if (!mountedRef.current) return;
        if (mode === 'initial') setLoading(false);
        if (mode === 'manual') setRefreshing(false);
      }
    })();
    readInFlightRef.current = operation;
    void operation.finally(() => {
      if (readInFlightRef.current === operation) readInFlightRef.current = null;
    });
    return operation;
  }, [setConnectionState]);

  /** Consulta a versão e baixa a fotografia apenas quando ela muda ou envelhece. */
  const checkVersion = useCallback((): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    if (versionInFlightRef.current) return versionInFlightRef.current;
    const now = Date.now();
    if (!shouldCheckVersion(lastCheckRef.current, now)) return Promise.resolve();
    lastCheckRef.current = now;
    const operation = (async () => {
      try {
        const version = await loadApoioVersion();
        if (!mountedRef.current) return;
        if (version.erro) return;
        const reload = shouldReloadSnapshot(
          { version: versionRef.current, loadedAt: loadedAtRef.current },
          version.fonteAtualizada,
          Date.now(),
          APOIO_SNAPSHOT_MAX_AGE_MS,
        );
        if (reload) await read('silent');
        else if (connectionRef.current !== 'live') setConnectionState('polling');
      } catch (checkError) {
        if (!mountedRef.current) return;
        setError(errorMessage(checkError));
        setConnectionState(isBrowserOnline() ? 'polling' : 'offline');
      }
    })();
    versionInFlightRef.current = operation;
    void operation.finally(() => {
      if (versionInFlightRef.current === operation) versionInFlightRef.current = null;
    });
    return operation;
  }, [read, setConnectionState]);

  const refresh = useCallback(async () => {
    await read('manual');
  }, [read]);

  useEffect(() => {
    mountedRef.current = true;
    void read('initial');
    return () => { mountedRef.current = false; };
  }, [read]);

  useEffect(() => {
    let active = true;
    const channel = apoioClient.channel('tv_orders_realtime');
    // Escuta só o controle de sincronização: um evento por minuto em vez de
    // um por ordem alterada, sem baixar a fotografia a cada evento.
    channel.on('postgres_changes', { event: '*', schema: 'public', table: TV_REALTIME_TABLE }, () => {
      if (!active || !mountedRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        if (!active || !mountedRef.current) return;
        void checkVersion();
      }, TV_DEBOUNCE_MS);
    });
    channel.subscribe((status: string) => {
      if (!active || !mountedRef.current) return;
      if (status === 'SUBSCRIBED') {
        setConnectionState('live');
        // Fecha a janela entre a leitura inicial e a assinatura Realtime.
        if (mountedRef.current) void checkVersion();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setConnectionState(isBrowserOnline() ? 'polling' : 'offline');
      }
    });
    return () => {
      active = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      void apoioClient.removeChannel(channel);
    };
  }, [checkVersion, setConnectionState]);

  useEffect(() => {
    const interval = setInterval(() => {
      // navigator.onLine é apenas uma dica e pode ficar false em webviews,
      // modos de economia ou redes com internet acessível. A consulta de
      // versão confirma a conexão sem baixar a fotografia inteira.
      void checkVersion();
    }, TV_POLL_MS);
    return () => clearInterval(interval);
  }, [checkVersion]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleOffline = () => setConnectionState('offline');
    const handleOnline = () => {
      if (connectionRef.current !== 'live') setConnectionState('polling');
      void checkVersion();
    };
    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (connectionRef.current !== 'live') setConnectionState('polling');
      void checkVersion();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisible);
    if (!isBrowserOnline()) setConnectionState('offline');
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [checkVersion, setConnectionState]);

  return { data, loading, refreshing, error, connection, lastReadAt, refresh };
}

export default useTVOrders;
