import { TipoCarteira, TipoRankingRecomendacao } from '../../services/investimento.service';
import { SectorMarketState } from './sector-market-state';
import { DynamicAllocationBandResult, DynamicRebalanceConfig, RebalanceToleranceMode } from './dynamic-allocation-band';

/** Origem do score de um ticker — binário nesta fase (ver plano, "RankingConfidence graduado"
 * fica pra quando alguma fase futura precisar de um 3º nível real, hoje seria fabricado sem
 * base de dado). 'segmento' = amostra confiável; 'setor_fallback' = segmento pequeno demais,
 * score redirecionado pro tier setor (ver RankingQueryService.getScoresSegmentoComFallback). */
export type OrigemScore = 'segmento' | 'setor_fallback';

export interface PortfolioPositionState {
  id: string;
  ticker: string;
  nome: string;
  tipo: 'acao' | 'fii' | 'renda_fixa';
  quantidade: number;
  precoMedio: number;
  cotacaoAtual: number | null;
  valorAtual: number;
  setor: string | null;
  segmento: string | null;
  scoreQualidade: number | null;
  qualidadeDelta: number | null;
  scoreRisco: number | null;
  riscoDelta: number | null;
  riscoComposto: number | null;
  scorePreco: number | null;
  precoDelta: number | null;
  scoreFinal: number | null;
  scoreFinalDelta: number | null;
  origemScore: OrigemScore | null;
}

export interface SectorAllocationState {
  setor: string;
  valorAtual: number;
  percentualAtual: number;
  percentualAlvo: number;
  /** percentualAtual − percentualAlvo. Positivo = sobrealocado, negativo = subalocado. */
  diferenca: number;
  status: 'sobrealocado' | 'subalocado' | 'equilibrado';
  /** true quando o setor tem alvo configurado mas ZERO ações hoje — "setor descoberto". */
  semNenhumaAcao: boolean;
}

/** Classificação por banda [min,max] — mesma regra estrutural usada tanto pela banda FIXA
 * (`computeSectorAllocation`, min/max = target∓percentualEstouro) quanto pela banda DINÂMICA
 * (`DynamicAllocationBandService`, min/max vêm da atratividade de Preço) — garante que as duas
 * classificam do mesmo jeito, só a banda em si muda. */
export function deriveSectorStatus(percentualAtual: number, min: number, max: number): SectorAllocationState['status'] {
  if (percentualAtual > max) return 'sobrealocado';
  if (percentualAtual < min) return 'subalocado';
  return 'equilibrado';
}

/** Função pura compartilhada por `PortfolioSnapshotService` (estado inicial) e
 * `PortfolioStateTransitionService.recalcularAgregados` (após cada move) — antes dessa extração,
 * a mesma lógica estava duplicada inline nos dois lugares. Chamada com denominadores diferentes
 * produz `sectors` (denominador vivo, legado/B1) e `stableSectors` (denominador estável,
 * `searchAllocationBase`, usado por B2/busca em diante — ver "achado" do Estouro Dinâmico:
 * `generateB2` precisa da MESMA base que `PortfolioEvaluatorService` usa pra pontuar). */
export function computeSectorAllocation(
  valorPorSetor: Map<string, number>,
  alocacoesAlvo: Map<string, number>,
  denominador: number,
  percentualEstouro: number,
): SectorAllocationState[] {
  const setoresNomes = new Set([...alocacoesAlvo.keys(), ...valorPorSetor.keys()]);
  return [...setoresNomes].map((setor) => {
    const valorAtual = valorPorSetor.get(setor) ?? 0;
    const percentualAtual = denominador > 0 ? (valorAtual / denominador) * 100 : 0;
    const percentualAlvo = alocacoesAlvo.get(setor) ?? 0;
    const diferenca = percentualAtual - percentualAlvo;
    const status = deriveSectorStatus(percentualAtual, percentualAlvo - percentualEstouro, percentualAlvo + percentualEstouro);
    return { setor, valorAtual, percentualAtual, percentualAlvo, diferenca, status, semNenhumaAcao: valorAtual <= 0 && percentualAlvo > 0 };
  });
}

/** Participação de UM segmento dentro de UM setor (não da carteira) — ver Fase C.1. */
export interface SegmentAllocationState {
  setor: string;
  segmento: string;
  valorAtual: number;
  percentualDoSetor: number;
  numeroPosicoes: number;
}

/** Concentração de segmento dentro de um setor — sinal estrutural que `SectorAllocationState`
 * sozinho não enxerga (um setor pode estar "equilibrado" no agregado e ainda assim 100%
 * concentrado num único segmento, ex: Financeiro só com Bancos, nada em Seguros/Bolsas). */
export interface SegmentConcentration {
  setor: string;
  segments: SegmentAllocationState[];
  maxSegmentShare: number;
  /** quantos segmentos distintos têm score calculável no universo pra este setor — evita marcar
   * "concentrado" um setor genuinamente mono-segmento (nada de verdade pra diversificar). */
  segmentosDisponiveisNoUniverso: number;
  concentrado: boolean;
}

/** % do setor concentrado num único segmento a partir do qual `concentrado=true`. Explícito e
 * isolado (mesmo espírito de `percentualEstouro`/`DELTA_SCORE_TROCA`) — fácil de revisar/ajustar. */
export const LIMIAR_CONCENTRACAO_SEGMENTO = 70;

/** Função pura compartilhada por `PortfolioSnapshotService` (estado inicial) e
 * `PortfolioStateTransitionService.recalcularAgregados` (após cada move) — ao contrário de
 * `sectors` (lógica antiga, já duplicada nos dois lugares e validada), esse cálculo é NOVO, então
 * uma função só evita duas implementações divergirem silenciosamente. */
export function computeSegmentConcentration(
  positions: PortfolioPositionState[],
  investmentUniverse: InvestmentCandidateMetadata[],
  sectors: SectorAllocationState[],
): SegmentConcentration[] {
  const segmentosNoUniversoPorSetor = new Map<string, Set<string>>();
  for (const c of investmentUniverse) {
    if (!c.setor || !c.segmento || c.scoreFinal == null) continue;
    if (!segmentosNoUniversoPorSetor.has(c.setor)) segmentosNoUniversoPorSetor.set(c.setor, new Set());
    segmentosNoUniversoPorSetor.get(c.setor)!.add(c.segmento);
  }

  const resultado: SegmentConcentration[] = [];
  for (const setorInfo of sectors) {
    const posicoesDoSetor = positions.filter((p) => p.setor === setorInfo.setor);
    if (!posicoesDoSetor.length) continue;

    const porSegmento = new Map<string, { valorAtual: number; numeroPosicoes: number }>();
    for (const p of posicoesDoSetor) {
      const segmento = p.segmento ?? 'sem_segmento';
      const atual = porSegmento.get(segmento) ?? { valorAtual: 0, numeroPosicoes: 0 };
      atual.valorAtual += p.valorAtual;
      atual.numeroPosicoes += 1;
      porSegmento.set(segmento, atual);
    }

    const valorTotalSetor = posicoesDoSetor.reduce((acc, p) => acc + p.valorAtual, 0);
    const segments: SegmentAllocationState[] = [...porSegmento.entries()].map(([segmento, v]) => ({
      setor: setorInfo.setor,
      segmento,
      valorAtual: v.valorAtual,
      percentualDoSetor: valorTotalSetor > 0 ? (v.valorAtual / valorTotalSetor) * 100 : 0,
      numeroPosicoes: v.numeroPosicoes,
    }));

    const maxSegmentShare = segments.reduce((max, s) => Math.max(max, s.percentualDoSetor), 0);
    const segmentosDisponiveisNoUniverso = segmentosNoUniversoPorSetor.get(setorInfo.setor)?.size ?? segments.length;

    resultado.push({
      setor: setorInfo.setor,
      segments,
      maxSegmentShare,
      segmentosDisponiveisNoUniverso,
      concentrado: maxSegmentShare >= LIMIAR_CONCENTRACAO_SEGMENTO && segmentosDisponiveisNoUniverso > 1,
    });
  }

  return resultado;
}

/** Todo ticker do universo com score calculável nesse anoMes/tipoRanking — não só os possuídos.
 * Construído UMA VEZ no snapshot pra que o MoveGenerator (Fase B) nunca precise voltar ao banco
 * pra descobrir candidatos (nem em profundidade >1, quando isso passaria a acontecer por nó). */
export interface InvestmentCandidateMetadata {
  ticker: string;
  nome: string;
  setor: string | null;
  segmento: string | null;
  cotacao: number | null;
  scoreQualidade: number | null;
  qualidadeDelta: number | null;
  scoreRisco: number | null;
  riscoDelta: number | null;
  riscoComposto: number | null;
  scorePreco: number | null;
  precoDelta: number | null;
  scoreFinal: number | null;
  scoreFinalDelta: number | null;
  /** Null quando tipoRanking='setor'/'geral'/'hibrido' — o conceito de fallback de amostra
   * pequena só existe pro tier 'segmento' (ver RankingQueryService.getScoresSegmentoComFallback). */
  origemScore: OrigemScore | null;
}

/** 3 fontes de capital economicamente diferentes — nunca somadas cegamente num "cash" só (ver
 * plano, ajuste 5). O engine precisa saber SE o dinheiro disponível é caixa parado, produto de
 * uma venda que o próprio plano/busca acabou de simular, ou aporte novo externo do usuário. */
export interface PortfolioCapitalState {
  /** Caixa parado hoje — só Simulação tem isso (SimulacaoConfig.caixaDisponivel); 0 na carteira real. */
  existingCash: number;
  /** Aporte novo informado pro cálculo em questão (ex: aporte semanal) — default 0, não inferido. */
  externalContributionBudget: number;
  /** Acumulado de vendas já aplicadas DENTRO da mesma simulação/busca — 0 no estado inicial,
   * incrementado por StateTransition a cada SELL/REDUCE (ver Fase B1). */
  proceedsGeneratedByPlan: number;
}

/** `availableToInvest` é sempre derivado, nunca um campo próprio — evita os 3 números saírem de
 * sincronia (ver plano, ajuste 5). */
export function availableToInvest(capital: PortfolioCapitalState): number {
  return capital.existingCash + capital.externalContributionBudget + capital.proceedsGeneratedByPlan;
}

export interface PortfolioState {
  userId: string;
  anoMes: string;
  carteira: TipoCarteira;
  positions: PortfolioPositionState[];
  capital: PortfolioCapitalState;
  valorTotalAcoes: number;
  /** Valor de TODA a carteira (ações + FIIs + renda fixa), com fallback pro custo (valorInvestido)
   * quando não há cotação — mesma semântica de SaudeCarteira.valorTotalCarteira hoje. Deliberadamente
   * diferente de `valorTotalAcoes` (que é só a fatia de ações, sem fallback, usada pro
   * rebalanceamento setorial) — `positions` aqui só contém ações, então esse total não dá pra
   * derivar delas sozinho. */
  valorTotalCarteira: number;
  /** Base ESTÁVEL pra % de setor no `search` (health/balance internos do motor) — capturada UMA
   * VEZ no snapshot (valorTotalAcoes + availableToInvest(capital) no estado inicial) e nunca
   * recomputada por StateTransition. Sem isso, vender uma posição sem recompra imediata encolhe
   * `valorTotalAcoes` e faz TODOS os outros setores parecerem mais alocados só porque o
   * denominador caiu — não porque mudou algo neles (invariante pedido pelo usuário antes da Fase
   * C). Os campos `sectors[].percentualAtual` legados (usados por B1/wrappers, bit-a-bit iguais
   * ao sistema atual) continuam usando o denominador vivo — essa base só alimenta o `search`. */
  searchAllocationBase: number;
  sectors: SectorAllocationState[];
  /** Mesma info de `sectors`, mas com `percentualAtual`/`status` medidos contra
   * `searchAllocationBase` (denominador estável) em vez de `valorTotalAcoes` (vivo) — é o que
   * `generateB2`/busca em diante devem usar (ver "Estouro Dinâmico"/achado do pré-requisito:
   * antes disso, `generateB2` decidia por um denominador diferente do que o Comparator pontuava).
   * `generateB1` continua em `sectors` — preserva compatibilidade bit-a-bit com a matriz legada. */
  stableSectors: SectorAllocationState[];
  /** = `stableSectors` em modo `rebalanceToleranceMode='FIXED'`; em modo `'DYNAMIC_PRICE'`, mesmos
   * valores/target, mas `status` recalculado pela banda de `dynamicAllocationBands` (min/max por
   * atratividade de Preço) em vez de `±percentualEstouro`. É isso que `generateB2` consome. */
  dynamicSectors: SectorAllocationState[];
  /** Preço/Qualidade/Risco agregados (Δ, top-3 por setor) — insumo da banda dinâmica, calculado
   * uma vez no snapshot a partir de `investmentUniverse` (zero query nova). */
  sectorMarketStates: SectorMarketState[];
  /** Auditoria completa da banda dinâmica por setor (Decision Trace) — vazio em modo `'FIXED'`. */
  dynamicAllocationBands: DynamicAllocationBandResult[];
  rebalanceToleranceMode: RebalanceToleranceMode;
  dynamicRebalanceConfig: DynamicRebalanceConfig;
  /** Concentração de segmento por setor (Fase C.1) — recalculado junto com `sectors`, tanto no
   * snapshot quanto a cada `StateTransition.apply` (ver `computeSegmentConcentration`). */
  segmentConcentration: SegmentConcentration[];
  percentualEstouro: number;
  permiteFracionario: boolean;
  tipoRanking: TipoRankingRecomendacao;
  investmentUniverse: InvestmentCandidateMetadata[];
  /** anoMes + tipoRanking + carteira — usado depois pra transposition table (Fase C). */
  rankingVersion: string;
}
