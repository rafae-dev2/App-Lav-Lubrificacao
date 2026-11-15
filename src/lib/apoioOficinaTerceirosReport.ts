import html2canvas from 'html2canvas';
import { reportDate } from './apoioReportData';
import {
  OFICINA_TERCEIROS_IMAGE,
  OFICINA_TERCEIROS_TITLE,
  type OficinaTerceirosEntry,
} from './apoioOficinaTerceirosData';

/**
 * Relatório em imagem "Equipamentos em Oficina de Terceiros".
 *
 * Composição própria, separada do relatório premium: uma única imagem PNG de
 * celular em pé, com 921 px de largura e pelo menos 1600 px de altura. Quando
 * a seleção não cabe em 1600 px a imagem cresce, em vez de virar ZIP ou
 * cortar registros. Cabeçalho verde no estilo do PDF e apenas três colunas
 * (Equipamento, Modelo e Prestador). Nada é lido ou gravado na fonte.
 */
export interface OficinaTerceirosOptions {
  /** Cores dos grupos Apoio (nome → cor) usadas como identificação da linha. */
  groupColors?: Record<string, string>;
  generatedAt?: Date;
}
export interface OficinaTerceirosProgress { phase: string; current: number; total: number; }

const PAGE_W = OFICINA_TERCEIROS_IMAGE.width;
const PAGE_H = OFICINA_TERCEIROS_IMAGE.height;
/** Limite de altura da imagem única (~70 linhas) para não travar o celular. */
export const OFICINA_TERCEIROS_MAX_HEIGHT = 12000;
const PADDING = 34;
const GREEN = '#1F6B45';
const DARK = '#14482F';
const BORDER = '#CFE5D7';
const INK = '#1B2A22';
const MUTED = '#5F7268';
const FONT = 'Arial, Helvetica, sans-serif';
// Mesmo fundo vetorial com blur do cabeçalho premium do Apoio.
const BACKGROUND = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="320" viewBox="0 0 1280 320"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#14482F"/><stop offset=".55" stop-color="#1F6B45"/><stop offset="1" stop-color="#2E8B57"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="48"/></filter></defs><rect width="1280" height="320" fill="url(#g)"/><g filter="url(#b)" opacity=".38"><ellipse cx="1020" cy="40" rx="235" ry="160" fill="#B1EBC9"/><ellipse cx="380" cy="290" rx="250" ry="160" fill="#2E8B57"/></g></svg>`);

const COLUMNS = [
  { key: 'frota', label: 'Equipamento', width: '18%' },
  { key: 'modelo', label: 'Modelo', width: '39%' },
  { key: 'prestador', label: 'Prestador', width: '43%' },
] as const;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  Object.assign(element.style, css);
  if (text !== undefined) element.textContent = text;
  return element;
}

function tint(color: string | undefined, alpha: number): string | null {
  const value = String(color ?? '').trim();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const hex = match[1].length === 3
    ? match[1].split('').map(char => char + char).join('')
    : match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function logoElement(size: number): HTMLImageElement {
  // O logotipo já é um PNG com fundo transparente: no cabeçalho ele aparece
  // direto sobre o verde, sem a caixa branca, como no PDF premium.
  const logo = node('img', {
    width: `${size}px`,
    height: `${size}px`,
    objectFit: 'contain',
    flexShrink: '0',
    filter: 'drop-shadow(0 6px 14px rgba(0,0,0,.28))',
  });
  logo.src = new URL('/logo.png', window.location.href).href;
  logo.alt = 'Branco Peres Agro';
  return logo;
}

export interface OficinaTerceirosLayout {
  root: HTMLDivElement;
  page: HTMLDivElement;
  /** Altura final da imagem: 1600 px ou o necessário para caber a seleção. */
  height: number;
  destroy: () => void;
}

/**
 * Monta a imagem única. A tabela ocupa toda a seleção; a página só cresce em
 * altura quando as linhas passam de 1600 px.
 */
export async function buildOficinaTerceirosPage(
  entries: readonly OficinaTerceirosEntry[],
  options: OficinaTerceirosOptions = {},
): Promise<OficinaTerceirosLayout> {
  if (!entries.length) throw new Error('Nenhum equipamento marcado para o relatório.');
  const generated = reportDate((options.generatedAt ?? new Date()).toISOString(), true);
  const oficinas = new Set(entries.map(entry => entry.prestador.toLocaleLowerCase('pt-BR'))).size;
  const root = node('div', {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: `${PAGE_W}px`,
    pointerEvents: 'none',
    zIndex: '-1',
  });
  document.body.append(root);

  const page = node('div', {
    width: `${PAGE_W}px`,
    minHeight: `${PAGE_H}px`,
    boxSizing: 'border-box',
    padding: `${PADDING}px`,
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    background: '#F5F9F6',
    color: INK,
    fontFamily: FONT,
  });

  const header = node('header', {
    flexShrink: '0',
    borderRadius: '26px',
    backgroundImage: `url("${BACKGROUND}")`,
    backgroundSize: 'cover',
    backgroundColor: GREEN,
    color: '#FFFFFF',
    border: '1px solid rgba(255,255,255,.32)',
    boxShadow: '0 10px 28px rgba(20,72,47,.18)',
    padding: '30px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  });
  const brand = node('div', { display: 'flex', alignItems: 'center', gap: '18px', minWidth: '0' });
  brand.append(logoElement(92));
  const brandText = node('div', { minWidth: '0' });
  brandText.append(node('div', { fontSize: '15px', letterSpacing: '2.6px', fontWeight: '700', opacity: '.92' }, 'BRANCO PERES AGRO'));
  brandText.append(node('div', { fontSize: '16px', marginTop: '6px', opacity: '.9' }, 'Controle de Equipamentos — Apoio'));
  brand.append(brandText);
  header.append(brand);

  const titleBlock = node('div', { minWidth: '0' });
  titleBlock.append(node('div', { fontSize: '12px', letterSpacing: '2.4px', fontWeight: '700', color: '#BDF6CF' }, 'RELATÓRIO DE MANUTENÇÃO'));
  titleBlock.append(node('h1', {
    fontSize: '38px',
    lineHeight: '1.12',
    fontWeight: '700',
    margin: '10px 0 0',
    letterSpacing: '-.4px',
    textTransform: 'uppercase',
  }, OFICINA_TERCEIROS_TITLE));
  header.append(titleBlock);
  const meta = node('div', { display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', fontSize: '15px', opacity: '.94' });
  meta.append(node('span', {}, `Gerado em ${generated}`));
  meta.append(node('span', {}, `${entries.length} ${entries.length === 1 ? 'equipamento' : 'equipamentos'} · ${oficinas} ${oficinas === 1 ? 'oficina' : 'oficinas'}`));
  header.append(meta);

  const body = node('div', { flex: '1 0 auto', display: 'flex', flexDirection: 'column' });
  const table = node('div', {
    borderRadius: '18px',
    overflow: 'hidden',
    border: `1px solid ${BORDER}`,
    background: '#FFFFFF',
    boxShadow: '0 6px 18px rgba(20,72,47,.05)',
    flexShrink: '0',
  });
  const head = node('div', { display: 'flex', background: GREEN, color: '#FFFFFF' });
  COLUMNS.forEach(column => {
    head.append(node('div', {
      width: column.width,
      flexShrink: '0',
      boxSizing: 'border-box',
      padding: '16px 12px',
      fontSize: '13px',
      fontWeight: '700',
      letterSpacing: '.3px',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }, column.label));
  });
  const tbody = node('div', { display: 'flex', flexDirection: 'column' });
  entries.forEach((entry, index) => {
    const background = tint(options.groupColors?.[entry.grupo], .16)
      ?? (index % 2 ? '#F2F8F4' : '#FFFFFF');
    const row = node('div', {
      display: 'flex',
      alignItems: 'center',
      background,
      borderTop: index ? `1px solid ${BORDER}` : 'none',
      flexShrink: '0',
    });
    row.dataset.oficinaTerceirosRow = 'true';
    const cells = [
      { text: entry.frota, fontSize: '25px', fontWeight: '700', color: DARK },
      { text: entry.modelo, fontSize: '21px', fontWeight: '400', color: INK },
      { text: entry.prestador, fontSize: '20px', fontWeight: '400', color: '#2C4A3A' },
    ];
    cells.forEach((cell, column) => {
      row.append(node('div', {
        width: COLUMNS[column].width,
        flexShrink: '0',
        boxSizing: 'border-box',
        padding: '15px 12px',
        fontSize: cell.fontSize,
        fontWeight: cell.fontWeight,
        color: cell.color,
        lineHeight: '1.32',
        overflowWrap: 'anywhere',
      }, cell.text));
    });
    tbody.append(row);
  });
  table.append(head, tbody);
  body.append(table);

  const footer = node('footer', {
    flexShrink: '0',
    height: '26px',
    boxSizing: 'border-box',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '10px',
    fontSize: '12px',
    fontWeight: '700',
    color: MUTED,
    paddingTop: '12px',
    borderTop: `1px solid ${BORDER}`,
  });
  footer.append(
    node('span', {}, 'BRANCO PERES AGRO · MANUTENÇÃO'),
    node('span', {}, `${entries.length} ${entries.length === 1 ? 'equipamento' : 'equipamentos'}`),
  );

  page.append(header, body, footer);
  root.append(page);

  try {
    const needed = Math.max(PAGE_H, Math.ceil(page.scrollHeight));
    if (needed > OFICINA_TERCEIROS_MAX_HEIGHT) {
      throw new Error('A seleção é grande demais para uma única imagem. Desmarque alguns equipamentos para manter o PNG leve.');
    }
    page.style.height = `${needed}px`;
    page.dataset.imageHeight = String(needed);
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all(Array.from(root.querySelectorAll('img')).map(image => image.decode().catch(() => undefined)));
    return { root, page, height: needed, destroy: () => root.remove() };
  } catch (error) {
    root.remove();
    throw error;
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function localStamp(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Renderiza a imagem única exatamente na largura de 921 px e na altura da
 * página (1600 px ou mais). Retorna o PNG em memória, sem baixar nada.
 */
export async function renderOficinaTerceirosPng(
  entries: readonly OficinaTerceirosEntry[],
  options: OficinaTerceirosOptions = {},
  onProgress?: (progress: OficinaTerceirosProgress) => void,
): Promise<{ blob: Blob; width: number; height: number }> {
  const layout = await buildOficinaTerceirosPage(entries, options);
  try {
    onProgress?.({ phase: 'Renderizando imagem', current: 1, total: 1 });
    layout.root.replaceChildren(layout.page);
    const canvas = await html2canvas(layout.page, {
      scale: 1,
      backgroundColor: '#F5F9F6',
      logging: false,
      useCORS: true,
      width: PAGE_W,
      height: layout.height,
      windowWidth: PAGE_W,
      windowHeight: layout.height,
    });
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => (value ? resolve(value) : reject(new Error('Não foi possível gerar o PNG.'))), 'image/png');
    });
    canvas.width = 0;
    canvas.height = 0;
    layout.page.replaceChildren();
    return { blob, width: PAGE_W, height: layout.height };
  } finally {
    layout.destroy();
  }
}

/** Baixa uma única imagem PNG, direto, sem ZIP. */
export async function exportOficinaTerceirosImages(
  entries: readonly OficinaTerceirosEntry[],
  options: OficinaTerceirosOptions = {},
  onProgress?: (progress: OficinaTerceirosProgress) => void,
): Promise<{ width: number; height: number; count: number }> {
  onProgress?.({ phase: 'Preparando imagem', current: 0, total: 0 });
  const { blob, width, height } = await renderOficinaTerceirosPng(entries, options, onProgress);
  const base = `equipamentos-oficina-terceiros-${localStamp(options.generatedAt ?? new Date())}`;
  download(blob, `${base}.png`);
  return { width, height, count: entries.length };
}
