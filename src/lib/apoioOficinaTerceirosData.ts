import { oficinaLabel, type ApoioReportRow } from '../types/apoio';
import { isApoioClosed } from './apoioFilters';
import { reportFleet } from './apoioReportData';

/**
 * Relatório "Equipamentos em Oficina de Terceiros".
 *
 * Projeção mínima usada para cobrar retorno da manutenção: somente frota,
 * modelo e a oficina externa onde o equipamento está. A seleção parte das
 * ordens já filtradas na tela e não altera a fonte.
 */
export const OFICINA_TERCEIROS_TITLE = 'Equipamentos em Oficina de Terceiros';
export const OFICINA_TERCEIROS_IMAGE = { width: 921, height: 1600 } as const;

export interface OficinaTerceirosEntry {
  frota: string;
  modelo: string;
  prestador: string;
  /** Grupo Apoio, usado apenas para a cor de identificação da linha. */
  grupo: string;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function fleetKey(frota: string): string {
  return frota
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

/**
 * Mantém apenas ordens ativas em Oficina Externa, uma linha por frota, na
 * ordem da seleção atual. Ordem encerrada ou ausente da listagem não é um
 * equipamento parado em oficina de terceiros.
 */
export function selectOficinaTerceirosEquipment(
  rows: readonly ApoioReportRow[],
): OficinaTerceirosEntry[] {
  const seen = new Set<string>();
  const entries: OficinaTerceirosEntry[] = [];
  for (const row of rows) {
    if (row.ativo === false) continue;
    if (isApoioClosed(row)) continue;
    if (oficinaLabel(clean(row.origem)) !== 'Oficina Externa') continue;
    const frota = reportFleet(row);
    if (frota === 'Sem frota informada') continue;
    const key = fleetKey(frota);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      frota,
      modelo: clean(row.modelo) || clean(row.equipamento) || 'Modelo não informado',
      prestador: clean(row.prestador) || 'Oficina não informada',
      grupo: clean(row.apoio),
    });
  }
  return entries;
}

/** Resumo exibido no aplicativo antes da exportação. */
export function oficinaTerceirosSummary(entries: readonly OficinaTerceirosEntry[]): string {
  const oficinas = new Set(entries.map(entry => entry.prestador.toLocaleLowerCase('pt-BR')));
  const equipamentos = entries.length === 1 ? '1 equipamento' : `${entries.length} equipamentos`;
  const totalOficinas = oficinas.size === 1 ? '1 oficina' : `${oficinas.size} oficinas`;
  return `${equipamentos} em oficina de terceiros · ${totalOficinas}`;
}

export interface OficinaTerceirosFilter {
  /** Busca livre em frota, modelo e oficina. */
  query?: string;
  /** Oficinas selecionadas; vazio considera todas. */
  prestadores?: readonly string[];
}

/**
 * Filtro exclusivo do relatório: não altera a lista de ordens da tela, apenas
 * quais equipamentos saem na imagem.
 */
export function filterOficinaTerceirosEntries(
  entries: readonly OficinaTerceirosEntry[],
  filter: OficinaTerceirosFilter = {},
): OficinaTerceirosEntry[] {
  const terms = fold(String(filter.query ?? '').trim()).split(/\s+/).filter(Boolean);
  const providers = new Set((filter.prestadores ?? []).map(prestador => prestador.toLocaleLowerCase('pt-BR')));
  return entries.filter(entry => {
    if (providers.size && !providers.has(entry.prestador.toLocaleLowerCase('pt-BR'))) return false;
    if (!terms.length) return true;
    const haystack = fold(`${entry.frota} ${entry.modelo} ${entry.prestador}`);
    return terms.every(term => haystack.includes(term));
  });
}

/** Oficinas presentes na seleção, com a quantidade de equipamentos de cada uma. */
export function oficinaTerceirosProviderOptions(
  entries: readonly OficinaTerceirosEntry[],
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.prestador, (counts.get(entry.prestador) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}
