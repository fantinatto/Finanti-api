import { TipoCarteira, TipoRankingRecomendacao } from '../../services/investimento.service';

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
  sectors: SectorAllocationState[];
  percentualEstouro: number;
  permiteFracionario: boolean;
  tipoRanking: TipoRankingRecomendacao;
  investmentUniverse: InvestmentCandidateMetadata[];
  /** anoMes + tipoRanking + carteira — usado depois pra transposition table (Fase C). */
  rankingVersion: string;
}
