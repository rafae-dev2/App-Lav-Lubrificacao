/**
 * useSchedules.ts — Hook principal de dados com cache local
 *
 * ESTRATÉGIA DE VELOCIDADE:
 * 1. Ao abrir o app: mostrar dados do cache local (localStorage) INSTANTANEAMENTE
 * 2. Em background: sincronizar com o snapshot Supabase e atualizar a UI
 * 3. Cache TTL: 5 minutos (somente como primeira pintura; o snapshot é fresco)
 * 4. Auto-refresh: a cada 15 segundos em background (sem bloquear a UI)
 * 5. Operações CRUD: atualização otimista; PCM edita somente campos premium via RPC
 *
 * ORDENAÇÃO:
 * - Dados são SEMPRE ordenados por rowIndex (ordem da planilha)
 * - Novos registros são inseridos na posição correta usando o rowIndex retornado
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Programacao, DashboardStats } from '../types';
import {
  fetchSchedules,
  appendRowToSheet,
  deleteRowFromSheet,
  updateRowInSheet,
} from '../lib/sheetsService';
import { cleanScheduleObservation } from '../lib/schedulePresentation';
import { supabase, LAVAGEM_TABLE } from '../lib/supabaseClient';
import { nanoid } from 'nanoid';

const CACHE_KEY      = 'bp_schedules_cache_v5';
const CACHE_META_KEY = 'bp_schedules_cache_meta_v5';
const LEGACY_CACHE_KEY = 'bp_schedules_cache_v4';
const LEGACY_CACHE_META_KEY = 'bp_schedules_cache_meta_v4';
const CACHE_TTL_MS   = 5 * 60 * 1000;  // 5 minutos
// Atualização automática em segundo plano. Serve como "quase tempo real"
// entre aparelhos MESMO sem o Realtime do Supabase ligado. Com o Realtime
// ligado (recomendado), a atualização é instantânea e este intervalo vira
// apenas uma rede de segurança.
// A fotografia de programações tem ~1,3 MB. Antes eram 4 cargas por minuto por
// tela aberta (240 por hora); agora o tempo real avisa e o intervalo é só a
// rede de segurança. A atualização manual continua instantânea.
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutos
/** Menor intervalo entre duas cargas disparadas por tempo real/foco. */
const REALTIME_MIN_MS = 2 * 60 * 1000;
const RESUME_MIN_MS = 60 * 1000;

// Janela de proteção: por quanto tempo uma alteração local JÁ CONFIRMADA no
// banco "vence" leituras do servidor que possam estar atrasadas. Isso é o que
// impede o item de "voltar" ao estado anterior (PROGRAMADO/ATRASADO) alguns
// segundos depois de clicar em Encerrar / Em andamento.
const PENDING_GRACE_MS = 6000;
const DELETED_GRACE_MS = 6000;
const PCM_READ_ONLY_MESSAGE = 'Registros PCM são somente leitura para exclusão nesta tela.';
const PCM_INSERT_MESSAGE = 'Registros PCM não podem ser inseridos.';

const EDITABLE_FIELDS = [
  'descricaoPonto',
  'tipoPreventiva',
  'dataProgramada',
  'horarioAgendado',
  'situacao',
  'dataRealizada',
  'observacao',
] as const;

type EditableField = typeof EDITABLE_FIELDS[number];

interface CacheMeta {
  timestamp: number;
  count: number;
}

/** Ordena por rowIndex para manter a mesma ordem da planilha */
function sortBySheetOrder(data: Programacao[]): Programacao[] {
  return [...data].sort((a, b) => (a.rowIndex ?? 9999) - (b.rowIndex ?? 9999));
}

function isAutomaticSchedule(schedule: Programacao | undefined): boolean {
  return schedule?.origemRegistro === 'PCM';
}

function valueForComparison(schedule: Programacao, field: EditableField): unknown {
  if (field === 'observacao') return cleanScheduleObservation(schedule);
  return schedule[field];
}

function sameEditableValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return String(a ?? '') === String(b ?? '');
}

function applyEditableUpdates(
  previous: Programacao,
  updates: Partial<Programacao>,
): Programacao {
  const next: Programacao = { ...previous };
  for (const field of EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) continue;
    const value = updates[field];
    if (value !== undefined) next[field] = value as never;
  }
  if (!isAutomaticSchedule(previous) && updates.frota !== undefined) {
    next.frota = updates.frota;
  }
  return next;
}

function changedEditableFields(
  previous: Programacao,
  next: Programacao,
): Partial<Programacao> {
  const changes: Partial<Programacao> = {};
  for (const field of EDITABLE_FIELDS) {
    const before = valueForComparison(previous, field);
    const after = valueForComparison(next, field);
    if (sameEditableValue(before, after)) continue;
    const changedValue = field === 'observacao'
      ? String(after ?? '').trim()
      : next[field];
    Object.assign(changes, { [field]: changedValue });
  }
  if (!isAutomaticSchedule(previous) && previous.frota !== next.frota) {
    changes.frota = next.frota;
  }
  return changes;
}

/**
 * Compara os campos "de negócio" de duas programações. Usado para saber se o
 * servidor JÁ reflete uma alteração local — quando reflete, deixamos de
 * proteger o item e passamos a confiar no servidor.
 */
function sameState(a: Programacao, b: Programacao): boolean {
  return (
    a.situacao === b.situacao &&
    a.dataProgramada === b.dataProgramada &&
    a.dataRealizada === b.dataRealizada &&
    a.horarioAgendado === b.horarioAgendado &&
    (a.observacao || '') === (b.observacao || '') &&
    a.tipoPreventiva === b.tipoPreventiva &&
    a.descricaoPonto === b.descricaoPonto &&
    a.frota === b.frota
  );
}

function invalidateLegacyCache(): void {
  try {
    localStorage.removeItem(LEGACY_CACHE_KEY);
    localStorage.removeItem(LEGACY_CACHE_META_KEY);
  } catch {
    // localStorage pode não existir durante SSR/testes — o cache v5 segue válido.
  }
}

function loadFromCache(): Programacao[] | null {
  try {
    invalidateLegacyCache();
    const meta = localStorage.getItem(CACHE_META_KEY);
    if (!meta) return null;
    const { timestamp } = JSON.parse(meta) as CacheMeta;
    if (Date.now() - timestamp > CACHE_TTL_MS) return null; // expirado
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return sortBySheetOrder(JSON.parse(raw) as Programacao[]);
  } catch {
    return null;
  }
}

function saveToCache(data: Programacao[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    const meta: CacheMeta = { timestamp: Date.now(), count: data.length };
    localStorage.setItem(CACHE_META_KEY, JSON.stringify(meta));
  } catch {
    // localStorage pode estar cheio — ignorar
  }
}

function clearCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_META_KEY);
    localStorage.removeItem(LEGACY_CACHE_KEY);
    localStorage.removeItem(LEGACY_CACHE_META_KEY);
  } catch { /* ignorar */ }
}

function getCacheAge(): string | null {
  try {
    const meta = localStorage.getItem(CACHE_META_KEY);
    if (!meta) return null;
    const { timestamp } = JSON.parse(meta) as CacheMeta;
    const ageMs = Date.now() - timestamp;
    if (ageMs < 60000) return 'há menos de 1 min';
    const mins = Math.floor(ageMs / 60000);
    return `há ${mins} min`;
  } catch {
    return null;
  }
}

export function useSchedules() {
  // Inicializar com dados do cache para exibição instantânea
  const [schedules, setSchedules]   = useState<Programacao[]>(() => loadFromCache() ?? []);
  const [loading, setLoading]       = useState<boolean>(() => !loadFromCache()); // false se há cache
  const [error, setError]           = useState<string | null>(null);
  const [lastSync, setLastSync]     = useState<string | null>(null);
  const [syncing, setSyncing]       = useState(false);
  const [fromCache, setFromCache]   = useState<boolean>(() => !!loadFromCache());
  const autoRefreshRef              = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncInProgressRef            = useRef<boolean>(false);
  const queuedSyncRef = useRef<{silent:boolean;fresh:boolean} | null>(null);
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const activeReadRef=useRef<AbortController | null>(null);
  useEffect(()=>{
    mountedRef.current=true;
    lifecycleRef.current+=1;
    return()=>{
      mountedRef.current=false;
      lifecycleRef.current+=1;
      queuedSyncRef.current=null;
      activeReadRef.current?.abort();
      activeReadRef.current=null;
      syncInProgressRef.current=false;
    };
  },[]);

  // Espelho sempre atualizado da lista atual — evita closures obsoletos nas
  // ações (updateSchedule/deleteSchedule) sem precisar recriar os callbacks.
  const schedulesRef                = useRef<Programacao[]>(schedules);
  useEffect(() => { schedulesRef.current = schedules; }, [schedules]);

  // Alterações locais já CONFIRMADAS no banco que devem prevalecer sobre
  // leituras atrasadas do servidor, até o servidor devolver o mesmo valor.
  const pendingWritesRef            = useRef<Map<string, { item: Programacao; ts: number }>>(new Map());
  // IDs recém-excluídos — impede que uma leitura atrasada "ressuscite" o item.
  const deletedIdsRef               = useRef<Map<string, number>>(new Map());
  // Debounce para eventos de tempo real (evita rajada de re-syncs).
  const realtimeDebounceRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncAtRef               = useRef<number>(0);

  // Sincronização principal — busca do banco e mescla com alterações locais
  const syncFromSheet = useCallback(async (silent = false, fresh = false) => {
    if(!mountedRef.current)return;
    if (syncInProgressRef.current) {
      const previous=queuedSyncRef.current;
      queuedSyncRef.current={silent:previous ? previous.silent && silent : silent,fresh:previous ? previous.fresh || fresh : fresh};
      return;
    }

    syncInProgressRef.current = true;
    const lifecycle=lifecycleRef.current;
    const controller=new AbortController();
    activeReadRef.current=controller;
    let timeout:ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    // Momento em que ESTE sync começou. Se uma alteração local foi confirmada
    // depois disso, este fetch pode ter dados antigos e não deve sobrescrevê-la.
    const syncStartTs = Date.now();
    if (!silent) setSyncing(true);
    setError(null);

    try {
      const data = await Promise.race([
        fetchSchedules({fresh,signal:controller.signal}),
        new Promise<never>((_,reject)=>{
          timeout=setTimeout(()=>{
            timedOut = true;
            reject(new Error('A consulta de Lavagem e Lubrificação excedeu 20 segundos. Tentando novamente.'));
            controller.abort();
          },20_000);
        }),
      ]);
      if(!mountedRef.current || lifecycle!==lifecycleRef.current)return;
      const sorted = sortBySheetOrder(data);
      const nowTs = Date.now();
      const prevLocal = schedulesRef.current;
      const serverIds = new Set(sorted.map(s => s.id));

      // Mescla os dados do servidor preservando alterações locais confirmadas
      // (Encerrar / Em andamento / Adiar / etc.). É isto que elimina o bug de
      // "clico e alguns segundos depois volta ao estado anterior".
      const merged = sorted
        .filter(si => {
          const delTs = deletedIdsRef.current.get(si.id);
          if (delTs != null) {
            if (nowTs - delTs < DELETED_GRACE_MS) return false; // exclusão recente: ignora "fantasma"
            deletedIdsRef.current.delete(si.id);
          }
          return true;
        })
        .map(si => {
          const p = pendingWritesRef.current.get(si.id);
          if (!p) return si;
          // Servidor JÁ reflete a alteração → paramos de proteger e confiamos nele.
          if (sameState(si, p.item)) { pendingWritesRef.current.delete(si.id); return si; }
          // Fetch começou ANTES da escrita, ou estamos dentro da janela de
          // proteção → mantém o valor local confirmado (não deixa "voltar").
          if (p.ts >= syncStartTs || nowTs - p.ts < PENDING_GRACE_MS) return p.item;
          // Alteração antiga e o servidor diverge (mudança externa) → aceita servidor.
          pendingWritesRef.current.delete(si.id);
          return si;
        });

      // Preserva itens recém-criados localmente que ainda não apareceram no servidor.
      const localOnly = prevLocal.filter(s => !serverIds.has(s.id) && !s.rowIndex);
      const finalArr = sortBySheetOrder([...merged, ...localOnly]);

      schedulesRef.current=finalArr;
      setSchedules(finalArr);
      saveToCache(finalArr);
      setFromCache(false);
      setLastSync(new Date().toLocaleString('pt-BR'));
      lastSyncAtRef.current = Date.now();
      console.log(`[useSchedules] ✅ ${finalArr.length} registros (mesclados; ${pendingWritesRef.current.size} alteração(ões) local(is) pendente(s))`);
    } catch (err: any) {
      if(!mountedRef.current || lifecycle!==lifecycleRef.current)return;
      if (!timedOut && (controller.signal.aborted || err?.name === 'AbortError')) return;
      const msg = err.message || 'Erro ao consultar as programações no Supabase';
      console.error('[useSchedules] ❌ Erro:', msg);

      const cached = loadFromCache();
      if (cached && cached.length > 0) {
        setSchedules(cached);
        setFromCache(true);
        setError(`Usando dados em cache (${getCacheAge()}). Erro: ${msg}`);
      } else {
        setError(msg);
        setSchedules([]);
      }
    } finally {
      if(timeout)clearTimeout(timeout);
      if(activeReadRef.current===controller)activeReadRef.current=null;
      if(mountedRef.current && lifecycle===lifecycleRef.current){
        if (!silent) setSyncing(false);
        setLoading(false);
        syncInProgressRef.current = false;
        const queued=queuedSyncRef.current;
        queuedSyncRef.current=null;
        if(queued)void syncFromSheet(queued.silent,queued.fresh);
      }
    }
  }, []);

  /** Baixa a fotografia só se a última leitura estiver mais velha que o limite. */
  const syncIfStale = useCallback((minAgeMs: number) => {
    if (!mountedRef.current || syncInProgressRef.current) return;
    if (lastSyncAtRef.current && Date.now() - lastSyncAtRef.current < minAgeMs) return;
    void syncFromSheet(true, true);
  }, [syncFromSheet]);

  // A confirmação é gravada pela RPC do histórico, fora do CRUD da tabela.
  // Buscar o snapshot fresco para refletir a data confirmada também no controle.
  useEffect(() => {
    const onExecutionConfirmed = () => {
      clearCache();
      void syncFromSheet(true, true);
    };
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('bp:pcm-execution-confirmed', onExecutionConfirmed);
    return () => window.removeEventListener('bp:pcm-execution-confirmed', onExecutionConfirmed);
  }, [syncFromSheet]);

  // Carga inicial: mostrar cache imediatamente, sincronizar em background
  useEffect(() => {
    let timer:ReturnType<typeof setTimeout> | undefined;
    const cached = loadFromCache();
    if (cached && cached.length > 0) {
      // Dados em cache disponíveis — mostrar imediatamente, sync em background
      setSchedules(cached);
      setFromCache(true);
      setLoading(false);
      const cacheAge = getCacheAge();
      setLastSync(`Cache local (${cacheAge})`);
      // Sync em background após 500ms (não bloqueia a renderização)
      timer=setTimeout(() => syncFromSheet(true,true), 500);
    } else {
      // Sem cache — fazer sync normal (com loading)
      void syncFromSheet(false,true);
    }
    return()=>{if(timer)clearTimeout(timer);};
  }, [syncFromSheet]);

  // Rede de segurança a cada 5 minutos; o tempo real cuida das mudanças.
  useEffect(() => {
    autoRefreshRef.current = setInterval(() => {
      syncIfStale(AUTO_REFRESH_MS);
    }, AUTO_REFRESH_MS);

    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, [syncIfStale]);

  // Abas em segundo plano podem ter timers congelados. Recuperar a tela/rede
  // deve consultar novamente, mesmo quando outra leitura ainda está em curso.
  useEffect(()=>{
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const resume=()=>{syncIfStale(RESUME_MIN_MS);};
    const visible=()=>{if(typeof document !== 'undefined' && document.visibilityState==='visible')resume();};
    window.addEventListener('focus',resume);
    window.addEventListener('online',resume);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange',visible);
    }
    return()=>{
      window.removeEventListener('focus',resume);
      window.removeEventListener('online',resume);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange',visible);
      }
    };
  },[syncIfStale]);

  // ─── Tempo real (Supabase Realtime) ────────────────────────────────────────
  // Escuta INSERT/UPDATE/DELETE na tabela e re-sincroniza (silencioso + fresco)
  // com um pequeno debounce. Assim, quando alguém em OUTRO aparelho muda um
  // status, esta tela atualiza sozinha na hora. O merge protege as alterações
  // locais ainda não confirmadas.
  useEffect(() => {
    let active=true;
    const channel = supabase
      .channel('lavagem_lubrificacao_realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: LAVAGEM_TABLE },
        (payload) => {
          if(!active)return;
          console.log('[useSchedules] 🔴 Realtime:', payload.eventType);
          if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
          realtimeDebounceRef.current = setTimeout(() => syncIfStale(REALTIME_MIN_MS), 400);
        },
      )
      .subscribe((status) => {
        if(!active)return;
        console.log('[useSchedules] Realtime status:', status);
        if(status==='SUBSCRIBED')syncIfStale(RESUME_MIN_MS);
      });

    return () => {
      active=false;
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      supabase.removeChannel(channel);
    };
  }, [syncIfStale]);

  // Refresh manual (com spinner visível e bypass de cache)
  const refresh = useCallback(() => {
    clearCache(); // forçar leitura fresca da planilha
    syncFromSheet(false, true);
  }, [syncFromSheet]);

  // ─── Adicionar múltiplos itens ────────────────────────────────────────────
  const addSchedules = useCallback(async (newItems: Programacao[]): Promise<{ sheetErrors: string[] }> => {
    const sheetErrors: string[] = [];
    const allowedItems = newItems.filter(item => {
      if (!isAutomaticSchedule(item)) return true;
      sheetErrors.push(`Frota ${item.frota}: ${PCM_INSERT_MESSAGE}`);
      return false;
    });
    const itemsWithId = allowedItems.map(item => ({ ...item, id: item.id || nanoid() }));

    if (itemsWithId.length === 0) return { sheetErrors };
    
    // Atualização otimista na UI — adicionar ao final temporariamente
    setSchedules(prev => {
      const updated = [...prev, ...itemsWithId];
      saveToCache(updated);
      return updated;
    });
    
    // Escrever na planilha
    for (const item of itemsWithId) {
      const result = await appendRowToSheet(item);
      if (!result.success) {
        sheetErrors.push(`Frota ${item.frota}: ${result.error}`);
      } else if (result.rowIndex) {
        // Atualizar o rowIndex do item otimista para posição correta
        setSchedules(prev => {
          const updated = prev.map(s => 
            s.id === item.id ? { ...s, rowIndex: result.rowIndex } : s
          );
          const sorted = sortBySheetOrder(updated);
          saveToCache(sorted);
          return sorted;
        });
      }
    }
    
    // Recarregar da planilha em background, mas SEM mostrar spinner global
    // (silent=true) e com leitura fresca (fresh=true). Isso garante que o usuário
    // veja "Adicionado na planilha!" imediatamente, sem precisar clicar de novo.
    clearCache();
    setTimeout(() => syncFromSheet(true, true), 800);
    setTimeout(() => syncFromSheet(true, true), 3000);
    return { sheetErrors };
  }, [syncFromSheet]);

  // ─── Adicionar item único ─────────────────────────────────────────────────
  const addSingleSchedule = useCallback(async (item: Programacao): Promise<{ success: boolean; sheetError?: string }> => {
    if (isAutomaticSchedule(item)) {
      return { success: false, sheetError: PCM_INSERT_MESSAGE };
    }
    const withId = { ...item, id: item.id || nanoid() };

    // Atualização otimista na UI — adicionar ao final temporariamente
    setSchedules(prev => {
      const updated = [...prev, withId];
      saveToCache(updated);
      return updated;
    });

    const result = await appendRowToSheet(withId);
    if (!result.success) {
      // Reverter atualização otimista em caso de erro
      setSchedules(prev => prev.filter(s => s.id !== withId.id));
      return { success: false, sheetError: result.error };
    }

    // Atualizar com o rowIndex correto retornado pela planilha
    if (result.rowIndex) {
      setSchedules(prev => {
        const updated = prev.map(s => 
          s.id === withId.id ? { ...s, rowIndex: result.rowIndex } : s
        );
        const sorted = sortBySheetOrder(updated);
        saveToCache(sorted);
        return sorted;
      });
    }

    // Recarregar da planilha em background sem bloquear a UI nem reabrir spinner.
    // Usar `silent=true, fresh=true` evita o efeito de tela travada ou de o
    // usuário ter que clicar de novo após salvar.
    clearCache();
    setTimeout(() => syncFromSheet(true, true), 800);
    setTimeout(() => syncFromSheet(true, true), 2500);
    return { success: true };
  }, [syncFromSheet]);

  // ─── Atualizar item ───────────────────────────────────────────────────────
  const updateSchedule = useCallback(async (id: string, updates: Partial<Programacao>): Promise<{ sheetError?: string }> => {
    // Usa o espelho (ref) para obter o item atual sem depender de closures.
    const previousItem = schedulesRef.current.find(s => s.id === id);
    if (!previousItem) {
      return { sheetError: 'Registro indisponível; sincronize os dados e tente novamente.' };
    }
    const updatedItem = applyEditableUpdates(previousItem, updates);
    const changes = changedEditableFields(previousItem, updatedItem);

    // Formulários podem devolver a entidade inteira (inclusive metadados antigos)
    // ao salvar. Sem diferença nos campos de negócio, não há escrita remota.
    if (Object.keys(changes).length === 0) return {};

    // Atualização otimista na UI.
    setSchedules(prev => {
      const updated = prev.map(s => (s.id === id ? updatedItem : s));
      saveToCache(updated);
      return updated;
    });

    if (updatedItem.rowIndex) {
      // Registra a intenção ANTES de aguardar a rede — assim qualquer leitura
      // em andamento (auto-refresh, etc.) não consegue sobrescrever a mudança.
      pendingWritesRef.current.set(id, { item: updatedItem, ts: Date.now() });

      const result = await updateRowInSheet(updatedItem.rowIndex, updatedItem, changes);
      if (!result.success) {
        // Falha REAL na gravação → reverte e remove a proteção.
        // Mantemos a versão anterior por uma janela curta para que um fetch
        // iniciado antes da resposta RPC não reaplique o estado otimista.
        pendingWritesRef.current.set(id, { item: previousItem, ts: Date.now() });
        setSchedules(prev => {
          const reverted = prev.map(s => (s.id === id ? previousItem : s));
          saveToCache(reverted);
          return reverted;
        });
        return { sheetError: result.error };
      }

      // Gravação confirmada. Atualiza o timestamp e re-sincroniza em segundo
      // plano para alinhar rowIndex/edições de outros usuários. O merge
      // preservará esta alteração até o servidor devolver o mesmo valor.
      pendingWritesRef.current.set(id, { item: updatedItem, ts: Date.now() });
      clearCache();
      setTimeout(() => syncFromSheet(true, true), 1200);
    }
    return {};
  }, [syncFromSheet]);

  // ─── Excluir item ─────────────────────────────────────────────────────────
  const deleteSchedule = useCallback(async (id: string): Promise<{ sheetError?: string }> => {
    const item = schedulesRef.current.find(s => s.id === id);
    const rowIndex = item?.rowIndex;

    if (isAutomaticSchedule(item)) {
      return { sheetError: PCM_READ_ONLY_MESSAGE };
    }

    console.log(`[useSchedules] Excluindo id=${id} rowIndex=${rowIndex}`);

    if (!rowIndex || rowIndex < 1) {
      console.error('[useSchedules] rowIndex inválido:', rowIndex);
      await syncFromSheet(false);
      return { sheetError: 'Não foi possível identificar o registro. Tente novamente após sincronizar.' };
    }

    // Primeiro apagar do banco
    const result = await deleteRowFromSheet(rowIndex);

    if (!result.success) {
      console.error('[useSchedules] Erro ao excluir:', result.error);
      return { sheetError: result.error };
    }

    // Protege contra leituras atrasadas que possam "ressuscitar" o registro.
    deletedIdsRef.current.set(id, Date.now());
    pendingWritesRef.current.delete(id);

    // Remoção da UI somente após confirmação do banco
    setSchedules(prev => {
      const updated = prev.filter(s => s.id !== id);
      saveToCache(updated);
      return updated;
    });

    clearCache();
    setTimeout(() => syncFromSheet(true, true), 800);

    return {};
  }, [syncFromSheet]);

  // ─── Estatísticas ─────────────────────────────────────────────────────────
  const stats: DashboardStats = {
    total:      schedules.length,
    pendente:   schedules.filter(s => s.situacao === 'PENDENTE').length,
    atrasado:   schedules.filter(s => s.situacao === 'ATRASADO').length,
    programado: schedules.filter(s => s.situacao === 'PROGRAMADO').length,
    encerrado:  schedules.filter(s => s.situacao === 'ENCERRADO').length,
    andamento:  schedules.filter(s => s.situacao === 'ANDAMENTO').length,
  };

  return {
    schedules,
    loading,
    error,
    syncing,
    lastSync,
    fromCache,
    stats,
    refresh,
    addSchedules,
    addSingleSchedule,
    updateSchedule,
    deleteSchedule,
  };
}
