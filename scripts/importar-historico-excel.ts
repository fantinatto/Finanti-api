/**
 * Backfill de meses históricos a partir de um export do Status Invest em Excel — roda a
 * MESMA lógica de mapeamento/filtro/score do IngestionService real (mapearAcao, filtro de
 * price > 0, calcularMedias, normalizarAcao, calcularScores), só trocando a fonte por JSON
 * pré-extraído da planilha em vez da chamada HTTP ao vivo. Ver
 * src/modules/market-data/services/ingestion.service.ts — qualquer mudança na fórmula de
 * score feita lá não se reflete aqui automaticamente, então mantenha as duas em sincronia se
 * este script for reaproveitado no futuro.
 *
 * Diferença deliberada do fluxo real: NÃO sobrescreve `Acao.nome/setor/segmento` de tickers
 * já existentes (só cria se o ticker ainda não existir) — evita que a classificação "atual"
 * de um ticker regrida pra um mês passado só porque o backfill rodou depois cronologicamente.
 * IndicadorMensal/MediaAgrupamento/ScoreNormalizado são sempre por anoMes, sem esse risco.
 * upsertTickerSetor também não é chamado aqui pelo mesmo motivo (e hoje não é lido em
 * nenhum lugar do app, só gravado).
 *
 * Uso: npx ts-node scripts/importar-historico-excel.ts <caminho-do-json>
 * O JSON é um objeto { "2026-04": StatusInvestItem[], "2026-06": StatusInvestItem[] }.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { StatusInvestItem } from '../src/modules/market-data/dto/statusinvest.types';
import { INDICATOR_CONFIG } from '../src/modules/market-data/scoring/indicator.config';
import { calcularMedias, calcularMediaEDesvio, IndicadoresMap } from '../src/modules/market-data/scoring/average.calculator';
import { calcularScores, normalizarAcao } from '../src/modules/market-data/scoring/normalizer';

type TipoGrupo = 'setor' | 'segmento';

interface AcaoEnriquecida {
  ticker: string;
  nome: string;
  setor: string | null;
  segmento: string | null;
  precoFechamento: number | null;
  indicadores: IndicadoresMap;
}

const prisma = new PrismaClient();

/** Cópia fiel de IngestionService.mapearAcao, sem o parâmetro bolsai (sem fallback pra dado histórico). */
function mapearAcao(item: StatusInvestItem): AcaoEnriquecida {
  const ehBanco = item.segmentname === 'Bancos';

  const indicadores: IndicadoresMap = {
    pl: item.p_l ?? null,
    pvp: item.p_vp ?? null,
    pEbit: item.p_ebit ?? null,
    roe: item.roe ?? null,
    roic: ehBanco ? null : (item.roic ?? null),
    roa: item.roa ?? null,
    margemBruta: item.margembruta ?? null,
    margemEbit: item.margemebit ?? null,
    margemLiquida: item.margemliquida ?? null,
    dy: item.dy ?? null,
    dividaLiquidaPatrimonio: item.dividaliquidapatrimonioliquido ?? null,
    // StatusInvestService nunca preenche esse campo no fluxo real (só bolsai preenchia) —
    // mantém paridade com o mapeamento real em vez de inventar um valor a partir de dividaliquidaebit.
    dividaLiquidaEbitda: null,
    cagrReceita5a: item.receitas_cagr5 ?? null,
    cagrLucro5a: item.lucros_cagr5 ?? null,
    lpa: item.lpa ?? null,
    vpa: item.vpa ?? null,
  };

  return {
    ticker: item.ticker,
    nome: item.companyname ?? item.ticker,
    setor: item.sectorname || null,
    segmento: item.segmentname || null,
    precoFechamento: item.price ?? null,
    indicadores,
  };
}

function isValida(ind: IndicadoresMap): boolean {
  const obrigatorios = ['pl', 'pvp', 'lpa', 'vpa', 'roe', 'roa', 'pEbit'] as const;
  return obrigatorios.every((campo) => ind[campo] != null);
}

function mediasParaPrisma(ind: IndicadoresMap): Record<string, number | null> {
  return {
    pl: (ind.pl as number | null | undefined) ?? null,
    pvp: (ind.pvp as number | null | undefined) ?? null,
    pEbit: (ind.pEbit as number | null | undefined) ?? null,
    roe: (ind.roe as number | null | undefined) ?? null,
    roic: (ind.roic as number | null | undefined) ?? null,
    roa: (ind.roa as number | null | undefined) ?? null,
    margemBruta: (ind.margemBruta as number | null | undefined) ?? null,
    margemEbit: (ind.margemEbit as number | null | undefined) ?? null,
    margemLiquida: (ind.margemLiquida as number | null | undefined) ?? null,
    dy: (ind.dy as number | null | undefined) ?? null,
    dividaLiquidaPatrimonio: (ind.dividaLiquidaPatrimonio as number | null | undefined) ?? null,
    dividaLiquidaEbitda: (ind.dividaLiquidaEbitda as number | null | undefined) ?? null,
    cagrReceita5a: (ind.cagrReceita5a as number | null | undefined) ?? null,
    cagrLucro5a: (ind.cagrLucro5a as number | null | undefined) ?? null,
  };
}

function indicadoresParaPrisma(ind: IndicadoresMap): Record<string, number | null> {
  return {
    ...mediasParaPrisma(ind),
    roa: (ind.roa as number | null | undefined) ?? 0,
    margemEbit: (ind.margemEbit as number | null | undefined) ?? 0,
    lpa: (ind.lpa as number | null | undefined) ?? 0,
    vpa: (ind.vpa as number | null | undefined) ?? 0,
  };
}

function normsParaPrisma(norms: IndicadoresMap): Record<string, number | null> {
  return {
    pl_norm: (norms['pl_norm'] as number | null | undefined) ?? null,
    pvp_norm: (norms['pvp_norm'] as number | null | undefined) ?? null,
    pEbit_norm: (norms['pEbit_norm'] as number | null | undefined) ?? null,
    roe_norm: (norms['roe_norm'] as number | null | undefined) ?? null,
    roic_norm: (norms['roic_norm'] as number | null | undefined) ?? null,
    roa_norm: (norms['roa_norm'] as number | null | undefined) ?? null,
    margemBruta_norm: (norms['margemBruta_norm'] as number | null | undefined) ?? null,
    margemEbit_norm: (norms['margemEbit_norm'] as number | null | undefined) ?? null,
    margemLiquida_norm: (norms['margemLiquida_norm'] as number | null | undefined) ?? null,
    dy_norm: (norms['dy_norm'] as number | null | undefined) ?? null,
    dividaLiquidaPatrimonio_norm: (norms['dividaLiquidaPatrimonio_norm'] as number | null | undefined) ?? null,
    dividaLiquidaEbitda_norm: (norms['dividaLiquidaEbitda_norm'] as number | null | undefined) ?? null,
    cagrReceita5a_norm: (norms['cagrReceita5a_norm'] as number | null | undefined) ?? null,
    cagrLucro5a_norm: (norms['cagrLucro5a_norm'] as number | null | undefined) ?? null,
  };
}

function agruparPor(acoes: AcaoEnriquecida[], tipo: TipoGrupo): Record<string, AcaoEnriquecida[]> {
  const grupos: Record<string, AcaoEnriquecida[]> = {};
  for (const acao of acoes) {
    const chave = tipo === 'setor' ? (acao.setor ?? '') : (acao.segmento ?? '');
    if (!chave) continue;
    if (!grupos[chave]) grupos[chave] = [];
    grupos[chave].push(acao);
  }
  return grupos;
}

async function upsertAcao(acao: AcaoEnriquecida, anoMes: string): Promise<void> {
  const existente = await prisma.acao.findUnique({ where: { ticker: acao.ticker }, select: { ticker: true } });
  if (!existente) {
    await prisma.acao.create({
      data: { ticker: acao.ticker, nome: acao.nome, setor: acao.setor, segmento: acao.segmento },
    });
  }

  const dados = indicadoresParaPrisma(acao.indicadores);
  const dadosIncompletos = !isValida(acao.indicadores);
  const pvp = acao.indicadores.pvp as number | null | undefined;
  const passivoADescoberto = pvp != null && pvp < 0;
  const extras = { dadosIncompletos, passivoADescoberto, precoFechamento: acao.precoFechamento };

  await prisma.indicadorMensal.upsert({
    where: { ticker_anoMes: { ticker: acao.ticker, anoMes } },
    update: { ...dados, ...extras },
    create: { ticker: acao.ticker, anoMes, ...dados, ...extras },
  });
}

async function processarMediasEScores(acoes: AcaoEnriquecida[], anoMes: string, tipoGrupo: TipoGrupo): Promise<void> {
  const grupos = agruparPor(acoes, tipoGrupo);

  for (const [nomeGrupo, acoesDoGrupo] of Object.entries(grupos)) {
    if (!nomeGrupo) continue;

    const indicadoresList = acoesDoGrupo.map((a) => a.indicadores);
    const medias = calcularMedias(indicadoresList, INDICATOR_CONFIG);
    const estatisticasGrupo = calcularMediaEDesvio(indicadoresList, INDICATOR_CONFIG.map((c) => c.field));

    await prisma.mediaAgrupamento.upsert({
      where: { tipoGrupo_nomeGrupo_anoMes: { tipoGrupo, nomeGrupo, anoMes } },
      update: mediasParaPrisma(medias),
      create: { tipoGrupo, nomeGrupo, anoMes, ...mediasParaPrisma(medias) },
    });

    for (const acao of acoesDoGrupo) {
      const norms = normalizarAcao(acao.indicadores, medias);
      const scores = calcularScores(norms, acao.indicadores, acao.setor, acao.segmento, estatisticasGrupo);
      const normsPrisma = normsParaPrisma(norms);

      await prisma.scoreNormalizado.upsert({
        where: { ticker_tipoGrupo_nomeGrupo_anoMes: { ticker: acao.ticker, tipoGrupo, nomeGrupo, anoMes } },
        update: { ...normsPrisma, ...scores },
        create: { ticker: acao.ticker, tipoGrupo, nomeGrupo, anoMes, ...normsPrisma, ...scores },
      });
    }
  }
}

async function importarMes(anoMes: string, itens: StatusInvestItem[]): Promise<void> {
  console.log(`\n=== ${anoMes}: ${itens.length} tickers na planilha ===`);

  // Mesmo filtro obrigatório de IngestionService.filtrarLista (price > 0) — os filtros
  // avançados opcionais não se aplicam aqui, um backfill histórico quer o universo completo.
  const filtrados = itens.filter((item) => item.price != null && item.price > 0);
  console.log(`${filtrados.length} após filtro obrigatório de price > 0`);

  const acoes = filtrados.map(mapearAcao);
  const incompletas = acoes.filter((a) => !isValida(a.indicadores)).length;
  console.log(
    `${incompletas} tickers com campo obrigatório faltando (sem fallback bolsai pra dado histórico — salvos com dadosIncompletos=true, igual ao fluxo real quando a segunda passada não completa)`,
  );

  let processadas = 0;
  let erros = 0;
  for (const acao of acoes) {
    try {
      await upsertAcao(acao, anoMes);
      processadas++;
    } catch (err) {
      console.error(`Erro ao persistir ${acao.ticker}: ${(err as Error).message}`);
      erros++;
    }
  }

  await processarMediasEScores(acoes, anoMes, 'setor');
  await processarMediasEScores(acoes, anoMes, 'segmento');

  console.log(`${anoMes} concluído: ${processadas} processadas, ${erros} erros`);
}

async function main(): Promise<void> {
  const caminhoJson = process.argv[2];
  if (!caminhoJson) {
    console.error('Uso: npx ts-node scripts/importar-historico-excel.ts <caminho-do-json>');
    process.exit(1);
  }

  const dados = JSON.parse(readFileSync(caminhoJson, 'utf-8')) as Record<string, StatusInvestItem[]>;

  // Ordem cronológica só pra log ficar legível — cada anoMes é isolado, a ordem não muda o resultado.
  const meses = Object.keys(dados).sort();
  for (const anoMes of meses) {
    await importarMes(anoMes, dados[anoMes]);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
