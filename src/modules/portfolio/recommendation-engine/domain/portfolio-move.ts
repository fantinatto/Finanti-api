/**
 * Sem ROTATE_CROSS_SECTOR nesta fase — a matriz atual nunca compara setores diferentes; só faz
 * sentido quando existir busca real comparando estados (Fase C). Sem HOLD/STOP como
 * PortfolioMove (ver plano, ajuste 3) — "nada a fazer por causa do caixa" é resolvido pelo
 * MoveGenerator simplesmente não emitindo candidato pra aquela necessidade (lista vazia), não
 * por uma pseudo-jogada. Um conceito de terminal/parar-busca só nasce na Fase C.
 */
export type PortfolioMoveType = 'BUY' | 'ADD_NEW_POSITION' | 'REDUCE' | 'SELL' | 'ROTATE_WITHIN_SECTOR';

export type RecommendationReason =
  | 'SECTOR_UNDERWEIGHT'
  | 'SECTOR_OVERWEIGHT'
  | 'LOW_RELATIVE_SCORE'
  | 'BETTER_SAME_SECTOR_OPPORTUNITY'
  | 'NEW_SECTOR_POSITION';

/** Binário nesta fase — 'segmento'->HIGH, 'setor_fallback'->MEDIUM. Ver domain/portfolio-state.ts
 * OrigemScore e o gap documentado de RankingConfidence graduado (LOW real) no plano. */
export type RankingConfidence = 'HIGH' | 'MEDIUM';

export interface PortfolioMove {
  id: string;
  type: PortfolioMoveType;
  /** id do Investimento de origem (posição já possuída) — presente em REDUCE/SELL/ROTATE_WITHIN_SECTOR. */
  sourcePositionId?: string;
  sourceTicker?: string;
  /** Ticker de destino — presente em BUY/ADD_NEW_POSITION/ROTATE_WITHIN_SECTOR. */
  targetTicker?: string;
  setor: string | null;
  amount: number;
  quantity?: number;
  primaryReason: RecommendationReason;
  secondaryReasons: RecommendationReason[];
  confidence: RankingConfidence;
  /** Só em ROTATE_WITHIN_SECTOR nascido de setor SUBALOCADO — reproduz uma particularidade real
   * da matriz atual: o valor/quantidade do rateio de compra (calculado ANTES da troca, pro caso
   * de virar 'aportar') continua aparecendo em `valorSugerido`/`quantidadeSugerida` mesmo quando
   * a categoria final é 'troca_sugerida', porque o código original nunca zera esses campos ao
   * setar sugestaoTroca. Fase B1 precisa reproduzir isso bit-a-bit; não é redesenhado aqui. */
  carryForwardSuggestion?: { amount: number; quantity: number | null };
}
