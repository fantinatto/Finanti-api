import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { calcularMediaEDesvio, EstatisticaCampo, IndicadoresMap } from '../scoring/average.calculator';

/**
 * Ranking de FII — pipeline isolado do de ações (sem setor/segmento/grupo, só um split interno
 * no pilar Valuation). Decisões tomadas com o usuário em 2026-10-08, a partir de uma sugestão
 * dele (mesma fórmula de Z-score+sigmoide que risco-delta.ts já usa pra ações — k=0.85, teto=3.0,
 * confirma consistência de escala):
 *
 * 1. dividend_cagr/cota_cagr ausentes (40%/32% do universo real) são EXCLUÍDOS da média/desvio e
 *    do sub-score individual (reponderado entre os componentes que sobram) — nunca zerados. Zerar
 *    trataria "sem histórico" como "caiu", o que é diferente e puniria fundo novo/sem dado da fonte.
 * 2. Liquidez mínima R$ 1.000/dia — mais baixa que a primeira versão (R$10k). Revisado em
 *    2026-10-08 depois que o usuário pediu pra aumentar o conjunto de elegíveis: R$10k excluía
 *    229/512 FIIs, e 200 deles só caíam por causa DESSE filtro (passariam em tudo mais) — mais da
 *    metade do universo fora do ranking. A distribuição real mostra que o grosso do problema é
 *    literalmente liquidez ZERO (52 FIIs) ou quase-zero (mais 93 abaixo de R$1k) — R$1.000 corta
 *    só esse cluster "não negocia de verdade" e recupera 46 FIIs com liquidez baixa mas real
 *    (R$1k-10k/dia). Ainda bem abaixo do limiar de ações (R$500k, que excluiria 71,6% do universo
 *    de FII — a mediana real é só R$67k/dia).
 * 3. Exclui tipoFundo fora de Tijolo/Papel/Misto (Financeiro e Outros/Consumo Cíclico/Bens
 *    Industriais, 22 fundos em 2026-10) — vazamento de classificação de SETOR DE AÇÃO pra dentro
 *    da categoria "fundos" da Status Invest (mesmo fenômeno de subType=fi-agro/fip/etf na brapi),
 *    não são FII de verdade.
 * 4. Duas travas de risco pós-sigmoide (proposta do usuário em 2026-10-08, validada com shadow
 *    test contra o ranking real antes de aplicar — ver AlertaRiscoFii): segmento "Fundo de
 *    Desenvolvimento" (49 fundos no catálogo, 100% classificados como Fundo Misto — carregam
 *    risco de obra/orçamento que nenhum dos 4 pilares captura, já que é um risco de CATEGORIA,
 *    não de indicador) leva ×0,85 na Preservação; "Dividend Trap" (DY>18% COM cota caindo —
 *    sinal de que o provento não é recorrente, decorre de devolução de capital) leva ×0,90 na
 *    Renda. Shadow test confirmou: só 22/300 FIIs afetados, zero efeito colateral em ticker sem
 *    nenhum dos dois sinais, overlap Top15 14/15 (só TGAR11 sai, exatamente o efeito pretendido —
 *    ia pro topo só por DY alto/P-VP baixo, mascarando erosão de cota de -15,8%/ano).
 * 5. Renda usa dividendCagr (DY médio 5 anos) em vez de dy bruto (12m) — decisão do usuário em
 *    2026-10-09, pra não premiar fundo com yield pontualmente inflado. dy continua em uso nos
 *    itens 2 e 4 acima (sanidade e dividend trap), que dependem do yield ATUAL de propósito.
 *    23% do universo elegível (69/300) não tem dividendCagr — fica sem scoreRenda (nunca 0,
 *    mesmo princípio do item 1: scoreFinal reponderado só entre os pilares que sobram).
 *
 * Calculado ON DEMAND (não persistido) — mesmo padrão já usado em getDiversificacao/
 * getBalanceamentoPorSegmentoFii: universo pequeno (~400 após filtro), custo de recomputar a
 * cada request é desprezível, evita migração nova só pra isso.
 */

const LIQUIDEZ_MINIMA_FII = 1_000;
const TIPOS_FUNDO_VALIDOS = ['Fundo de Tijolo', 'Fundo de Papel', 'Fundo Misto'];

// Teto de sanidade (espelha o piso de liquidez, mas do lado do dado quebrado) — confirmado
// contra dados reais em 2026-10-08: sem isso, fundos com DY=4767%/6100% e liquidez de R$10-20
// BILHÕES/dia (claramente erro de fonte, não risco real) iam pro topo do ranking e distorciam
// a média/desvio de todo mundo. Só ~8 linhas no universo real passam algum desses tetos.
const DY_MAXIMO_SANIDADE = 50;
const PVP_MAXIMO_SANIDADE = 5;
const LIQUIDEZ_MAXIMA_SANIDADE = 500_000_000;

// Travas de risco pós-sigmoide — ver item 4 do comentário acima.
const SEGMENTO_DESENVOLVIMENTO = 'Fundo de Desenvolvimento';
const PENALIDADE_DESENVOLVIMENTO = 0.85;
const DY_MINIMO_DIVIDEND_TRAP = 18;
const PENALIDADE_DIVIDEND_TRAP = 0.9;

// Mesma constante de risco-delta.ts (DELTA_K/DELTA_TETO) — consistência de escala 0-3 com o
// resto do projeto, não reimporta de lá porque aquele arquivo é fortemente acoplado a
// INDICATOR_CONFIG/getPesosGrupo (setor/segmento de ação), que não existe pra FII.
const SIGMOIDE_K = 0.85;
const SIGMOIDE_TETO = 3.0;

export interface FiiRankingItem {
  ticker: string;
  nome: string;
  tipoFundo: string | null;
  segmento: string | null;
  dy: number | null;
  pvp: number | null;
  liquidezMediaDiaria: number | null;
  patrimonio: number | null;
  scoreValuation: number | null;
  scoreRenda: number | null;
  scoreLiquidezPorte: number | null;
  scorePreservacao: number | null;
  scoreFinal: number | null;
  /** 'desenvolvimento' | 'dividend_trap' | 'desenvolvimento+dividend_trap' | null — ver item 4
   * do comentário do arquivo. Só diagnóstico/transparência, o efeito já está no score final. */
  alertaRisco: string | null;
}

function sigmoide(z: number): number {
  return SIGMOIDE_TETO / (1 + Math.exp(-SIGMOIDE_K * z));
}

function zScore(
  valor: number | null | undefined,
  stats: EstatisticaCampo | null,
  direction: 'higher_better' | 'lower_better',
): number | null {
  if (valor === null || valor === undefined || isNaN(valor) || !stats) return null;
  const z = direction === 'higher_better' ? (valor - stats.media) / stats.desvioPadrao : (stats.media - valor) / stats.desvioPadrao;
  return sigmoide(z);
}

/** Combina sub-scores já em escala 0-3 pelos pesos informados, ignorando nulls e reponderando
 * entre os que sobram — mesmo princípio de calcularScoreDeltaGrupo (ações): null nunca é 0,
 * é "fora do rateio". */
function combinarPonderado(pares: Array<[number | null, number]>): number | null {
  let pesoPonderado = 0;
  let pesoTotal = 0;
  for (const [valor, peso] of pares) {
    if (valor === null) continue;
    pesoPonderado += valor * peso;
    pesoTotal += peso;
  }
  return pesoTotal > 0 ? pesoPonderado / pesoTotal : null;
}

@Injectable()
export class FiiRankingService {
  constructor(private readonly prisma: PrismaService) {}

  async getRanking(anoMes: string): Promise<FiiRankingItem[]> {
    const rows = await this.prisma.indicadorMensalFii.findMany({
      where: { anoMes },
      include: { fii: { select: { nome: true, tipoFundo: true, segmento: true } } },
    });

    const elegiveis = rows.filter(
      (r) =>
        (r.liquidezMediaDiaria ?? 0) >= LIQUIDEZ_MINIMA_FII &&
        (r.liquidezMediaDiaria ?? 0) <= LIQUIDEZ_MAXIMA_SANIDADE &&
        (r.dy ?? 0) <= DY_MAXIMO_SANIDADE &&
        (r.pvp ?? 0) <= PVP_MAXIMO_SANIDADE &&
        TIPOS_FUNDO_VALIDOS.includes(r.fii.tipoFundo ?? ''),
    );
    if (!elegiveis.length) return [];

    const prep = elegiveis.map((r) => ({
      ...r,
      desvioPvpPapel: r.pvp != null ? Math.abs(r.pvp - 1.0) : null,
      logLiquidez: r.liquidezMediaDiaria != null ? Math.log(Math.max(1, r.liquidezMediaDiaria)) : null,
      logPatrimonio: r.patrimonio != null ? Math.log(Math.max(1, r.patrimonio)) : null,
    }));

    type Preparado = (typeof prep)[number];
    const ehPapel = (r: Preparado) => r.fii.tipoFundo === 'Fundo de Papel';
    const papel = prep.filter(ehPapel);
    const tijoloMisto = prep.filter((r) => !ehPapel(r));

    const statsPvpTijoloMisto = calcularMediaEDesvio(tijoloMisto.map((r) => ({ pvp: r.pvp })), ['pvp'])['pvp'];
    const statsDesvioPvpPapel = calcularMediaEDesvio(papel.map((r) => ({ desvioPvpPapel: r.desvioPvpPapel })), ['desvioPvpPapel'])[
      'desvioPvpPapel'
    ];

    const camposGlobais = ['dividendCagr', 'logLiquidez', 'logPatrimonio', 'cotaCagr', 'percentualCaixa'] as const;
    const statsGlobais = calcularMediaEDesvio(
      prep.map((r): IndicadoresMap => ({
        dividendCagr: r.dividendCagr,
        logLiquidez: r.logLiquidez,
        logPatrimonio: r.logPatrimonio,
        cotaCagr: r.cotaCagr,
        percentualCaixa: r.percentualCaixa,
      })),
      [...camposGlobais],
    );

    const resultados: FiiRankingItem[] = prep.map((r) => {
      const scoreValuation = ehPapel(r)
        ? zScore(r.desvioPvpPapel, statsDesvioPvpPapel, 'lower_better')
        : zScore(r.pvp, statsPvpTijoloMisto, 'lower_better');

      // Renda usa dividendCagr (DY médio de 5 anos, decisão do usuário em 2026-10-09) em vez do
      // dy bruto (12m) — o trailing sofre com pico/vale pontual, o CAGR de 5 anos é mais estável.
      // dy continua usado nos dois sinais abaixo (sanidade/dividend trap) de propósito: ambos
      // dependem especificamente do yield ATUAL, não da média — são detectores de anomalia
      // pontual, não o indicador de renda recorrente.
      const scoreRenda = zScore(r.dividendCagr, statsGlobais['dividendCagr'], 'higher_better');

      const scoreLiquidezPorte = combinarPonderado([
        [zScore(r.logLiquidez, statsGlobais['logLiquidez'], 'higher_better'), 0.6],
        [zScore(r.logPatrimonio, statsGlobais['logPatrimonio'], 'higher_better'), 0.4],
      ]);

      let scorePreservacao = combinarPonderado([
        [zScore(r.cotaCagr, statsGlobais['cotaCagr'], 'higher_better'), 0.7],
        [zScore(r.percentualCaixa, statsGlobais['percentualCaixa'], 'higher_better'), 0.3],
      ]);

      let scoreRendaAjustado = scoreRenda;
      const alertas: string[] = [];

      if (r.fii.segmento === SEGMENTO_DESENVOLVIMENTO && scorePreservacao != null) {
        scorePreservacao *= PENALIDADE_DESENVOLVIMENTO;
        alertas.push('desenvolvimento');
      }
      if ((r.dy ?? 0) > DY_MINIMO_DIVIDEND_TRAP && r.cotaCagr != null && r.cotaCagr < 0 && scoreRendaAjustado != null) {
        scoreRendaAjustado *= PENALIDADE_DIVIDEND_TRAP;
        alertas.push('dividend_trap');
      }

      const scoreFinal = combinarPonderado([
        [scoreValuation, 0.3],
        [scoreRendaAjustado, 0.3],
        [scoreLiquidezPorte, 0.25],
        [scorePreservacao, 0.15],
      ]);

      return {
        ticker: r.ticker,
        nome: r.fii.nome,
        tipoFundo: r.fii.tipoFundo,
        segmento: r.fii.segmento,
        dy: r.dy,
        pvp: r.pvp,
        liquidezMediaDiaria: r.liquidezMediaDiaria,
        patrimonio: r.patrimonio,
        scoreValuation,
        scoreRenda: scoreRendaAjustado,
        scoreLiquidezPorte,
        scorePreservacao,
        scoreFinal,
        alertaRisco: alertas.length ? alertas.join('+') : null,
      };
    });

    return resultados.sort((a, b) => (b.scoreFinal ?? -Infinity) - (a.scoreFinal ?? -Infinity));
  }
}
