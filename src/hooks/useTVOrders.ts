import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApoioData } from '../types/apoio';
import { apoioClient, loadApoioData } from '../lib/apoioService';

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

const TV_POLL_MS = 30_000;
const TV_DEBOUNCE_MS = 400;
const TV_TABLES = ['apoio_ordens', 'apoio_sync', 'apoio_grupos', 'apoio_frotas'] as const;

function isBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Não foi possível ler o snapshot Apoio.';
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readAgainRef = useRef(false);

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
        const next = await loadApoioData();
        if (!mountedRef.current) return;
        setData(next);
        setLastReadAt(new Date().toISOString());
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
    for (const table of TV_TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        if (!active || !mountedRef.current) return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          if (!active || !mountedRef.current) return;
          if (readInFlightRef.current) {
            if (readAgainRef.current) return;
            readAgainRef.current = true;
            void readInFlightRef.current.finally(() => {
              readAgainRef.current = false;
              if (active && mountedRef.current) void read('silent');
            });
          } else void read('silent');
        }, TV_DEBOUNCE_MS);
      });
    }
    channel.subscribe((status: string) => {
      if (!active || !mountedRef.current) return;
      if (status === 'SUBSCRIBED') {
        setConnectionState('live');
        // Fecha a janela entre a leitura inicial e a assinatura Realtime.
        if (mountedRef.current) void read('silent');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setConnectionState(isBrowserOnline() ? 'polling' : 'offline');
      }
    });
    return () => {
      active = false;
      readAgainRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      void apoioClient.removeChannel(channel);
    };
  }, [read, setConnectionState]);

  useEffect(() => {
    const interval = setInterval(() => {
      // navigator.onLine é apenas uma dica e pode ficar false em webviews,
      // modos de economia ou redes com internet acessível. Tente o snapshot
      // periodicamente mesmo assim; apenas a resposta HTTP confirma a conexão.
      void read('silent');
    }, TV_POLL_MS);
    return () => clearInterval(interval);
  }, [read]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleOffline = () => setConnectionState('offline');
    const handleOnline = () => {
      if (connectionRef.current !== 'live') setConnectionState('polling');
      void read('silent');
    };
    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (connectionRef.current !== 'live') setConnectionState('polling');
      void read('silent');
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
  }, [read, setConnectionState]);

  return { data, loading, refreshing, error, connection, lastReadAt, refresh };
}

export default useTVOrders;
