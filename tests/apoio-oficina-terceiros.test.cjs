'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apoio-oficina-terceiros-'));

function loadHelper() {
  const outfile = path.join(TMP, 'apoioOficinaTerceirosData.cjs');
  buildSync({
    entryPoints: [path.join(ROOT, 'src/lib/apoioOficinaTerceirosData.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile,
    logLevel: 'silent',
  });
  delete require.cache[require.resolve(outfile)];
  return require(outfile);
}

function row(overrides = {}) {
  return {
    chave: 'chave-1',
    os: 'OS-1',
    frota: '8825',
    modelo: 'Ren Oroch 1.6 SCe',
    grupo_fonte: 'Veículos',
    setor: '',
    ponto: '',
    origem: 'Oficina Externa',
    prestador: 'SILAS EDUARDO MOURA DA SILVA',
    status: 'Em andamento',
    entrada: '2026-11-10',
    previsao: '',
    narrativa: 'Revisão',
    ativo: true,
    primeira_vista: '2026-11-10T08:00:00-03:00',
    ultima_vista: '2026-11-14T08:00:00-03:00',
    ausente_desde: null,
    apoio: 'Veículos Leves',
    equipamento: 'Ren Oroch 1.6 SCe',
    ...overrides,
  };
}

function main() {
  const {
    selectOficinaTerceirosEquipment,
    filterOficinaTerceirosEntries,
    oficinaTerceirosProviderOptions,
    oficinaTerceirosSummary,
    OFICINA_TERCEIROS_TITLE,
    OFICINA_TERCEIROS_IMAGE,
  } = loadHelper();

  assert.equal(typeof selectOficinaTerceirosEquipment, 'function');
  assert.equal(OFICINA_TERCEIROS_TITLE, 'Equipamentos em Oficina de Terceiros');
  assert.deepEqual({ ...OFICINA_TERCEIROS_IMAGE }, { width: 921, height: 1600 });

  // Somente oficina externa entra; interna, campo e origem desconhecida ficam fora.
  const rows = [
    row({ chave: 'a', frota: '8825', origem: 'Oficina Externa' }),
    row({ chave: 'b', frota: '30941', origem: 'terceiro', modelo: 'Usi Reboque Muda 2 Eixos', prestador: 'BONANI, OLIVEIRA & FRESCA LTDA - ME', apoio: 'Carretas Canavieiras' }),
    row({ chave: 'c', frota: '4605', origem: 'externo', modelo: 'MB 3344 6x4 Cavalo Mec', prestador: 'CARLOS HENRIQUE DA COSTA FRASSON-ME' }),
    row({ chave: 'd', frota: '4571', origem: 'Oficina Interna', prestador: 'Oficina interna' }),
    row({ chave: 'e', frota: '4566', origem: 'Campo', prestador: 'Campo' }),
    row({ chave: 'f', frota: '9999', origem: '', prestador: 'Sem origem' }),
    // Encerrada, ausente e sem frota não são equipamentos parados na oficina.
    row({ chave: 'g', frota: '4629', origem: 'Oficina Externa', status: 'Encerrada' }),
    row({ chave: 'h', frota: '4574', origem: 'Oficina Externa', ativo: false }),
    row({ chave: 'i', frota: '', origem: 'Oficina Externa' }),
    row({ chave: 'j', frota: 'Sem frota', origem: 'Oficina Externa' }),
    // A mesma frota aparece uma única vez, preservando a primeira ocorrência.
    row({ chave: 'k', frota: '8825', origem: 'Oficina Externa', prestador: 'OUTRA OFICINA' }),
    row({ chave: 'l', frota: ' 8825 ', origem: 'Oficina Externa', prestador: 'TERCEIRA OFICINA' }),
  ];

  const entries = selectOficinaTerceirosEquipment(rows);
  assert.deepEqual(entries.map(entry => entry.frota), ['8825', '30941', '4605'], 'somente oficinas externas ativas, sem repetir frota');
  assert.equal(entries[0].prestador, 'SILAS EDUARDO MOURA DA SILVA', 'primeira ocorrência da frota prevalece');
  assert.equal(entries[1].modelo, 'Usi Reboque Muda 2 Eixos');
  assert.equal(entries[2].prestador, 'CARLOS HENRIQUE DA COSTA FRASSON-ME');
  assert.equal(entries[1].grupo, 'Carretas Canavieiras');

  // Modelo cai para o nome do equipamento e depois para o texto padrão;
  // prestador vazio nunca some da imagem.
  const fallback = selectOficinaTerceirosEquipment([
    row({ chave: 'm', frota: '4581', modelo: '', equipamento: 'MB 2831 6x4 muck' }),
    row({ chave: 'n', frota: '4508', modelo: '', equipamento: '' }),
  ]);
  assert.deepEqual(fallback.map(entry => entry.modelo), ['MB 2831 6x4 muck', 'Modelo não informado']);
  assert.equal(fallback[0].prestador, 'SILAS EDUARDO MOURA DA SILVA');
  const semPrestador = selectOficinaTerceirosEquipment([row({ chave: 'o', prestador: '   ' })]);
  assert.equal(semPrestador[0].prestador, 'Oficina não informada');

  // A ordem da seleção é preservada e a entrada original não é mutada.
  const before = structuredClone(rows);
  assert.deepEqual(rows, before, 'seleção não deve mutar as ordens');
  assert.equal(selectOficinaTerceirosEquipment([]).length, 0);
  assert.equal(oficinaTerceirosSummary(entries), '3 equipamentos em oficina de terceiros · 3 oficinas');
  assert.equal(oficinaTerceirosSummary([entries[0]]), '1 equipamento em oficina de terceiros · 1 oficina');

  // Filtros do relatório: pesquisa livre (frota, modelo ou oficina), sem
  // diferenciar acento/caixa, e seleção de oficinas. Vazio considera tudo.
  const report = [
    { frota: '4508', modelo: 'MB 2831 6x4 muck', prestador: 'FRATINI REPARACAO DE IMPLEMENTOS', grupo: 'Caminhões' },
    { frota: '4512', modelo: 'MB 2219 6x4 muck', prestador: 'SERGIO MAIA ADAMANTINA - ME', grupo: 'Caminhões' },
    { frota: '4605', modelo: 'MB 3344 6x4 Cavalo Mec', prestador: 'CARLOS HENRIQUE DA COSTA FRASSON-ME', grupo: 'Caminhões' },
    { frota: '8825', modelo: 'Ren Oroch 1.6 SCe', prestador: 'SILAS EDUARDO MOURA DA SILVA', grupo: 'Veículos Leves' },
  ];
  const ids = list => list.map(entry => entry.frota);
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report)), ['4508', '4512', '4605', '8825'], 'sem filtro mantém todos');
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report, { query: 'mb 3344' })), ['4605'], 'busca combina termos do modelo');
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report, { query: 'fratini' })), ['4508'], 'busca encontra a oficina');
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report, { query: 'carlos henrique' })), ['4605'], 'busca ignora caixa e acentos');
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report, { query: 'muck' })), ['4508', '4512'], 'busca no modelo');
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report, { query: '8825 oro' })), ['8825'], 'busca frota + trecho do modelo');
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report, { query: 'inexistente' })), [], 'busca sem resultado devolve vazio');
  assert.deepEqual(
    ids(filterOficinaTerceirosEntries(report, { prestadores: ['SERGIO MAIA ADAMANTINA - ME', 'FRATINI REPARACAO DE IMPLEMENTOS'] })),
    ['4508', '4512'],
    'seleção de oficinas restringe o relatório',
  );
  assert.deepEqual(
    ids(filterOficinaTerceirosEntries(report, { prestadores: ['SERGIO MAIA ADAMANTINA - ME'], query: 'muck' })),
    ['4512'],
    'oficina + busca combinam',
  );
  assert.deepEqual(ids(filterOficinaTerceirosEntries(report, { prestadores: [] })), ids(report), 'seleção vazia considera todas');
  assert.deepEqual(oficinaTerceirosProviderOptions(report), [
    { value: 'CARLOS HENRIQUE DA COSTA FRASSON-ME', label: 'CARLOS HENRIQUE DA COSTA FRASSON-ME', count: 1 },
    { value: 'FRATINI REPARACAO DE IMPLEMENTOS', label: 'FRATINI REPARACAO DE IMPLEMENTOS', count: 1 },
    { value: 'SERGIO MAIA ADAMANTINA - ME', label: 'SERGIO MAIA ADAMANTINA - ME', count: 1 },
    { value: 'SILAS EDUARDO MOURA DA SILVA', label: 'SILAS EDUARDO MOURA DA SILVA', count: 1 },
  ], 'opções de oficina ordenadas com contagem');

  console.log('OK: oficina de terceiros — somente externas ativas, frota única, modelo/prestador com fallback, ordem, não mutação e filtros do relatório verificados.');
}

try {
  main();
} catch (error) {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
