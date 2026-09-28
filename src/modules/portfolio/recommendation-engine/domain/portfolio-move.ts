import { availableToInvest, PortfolioState } from './portfolio-state';

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
  | 'NEW_SECTOR_POSITION'
  | 'SEGMENT_CONCENTRATION';

/** Binário nesta fase — 'segmento'->HIGH, 'setor_fallback'->MEDIUM. Ver domain/portfolio-state.ts
 * OrigemScore e o gap documentado de RankingConfidence graduado (LOW real) no plano. */
export type RankingConfidence = 'HIGH' | 'MEDIUM';

/** Estratégia de tamanho de um REDUCE/SELL gerado pelo B2 (setor sobrealocado) — puramente
 * informativo (Decision Trace/explicabilidade), NÃO afeta `type`/mecânica de execução. Evita
 * inventar frações arbitrárias (25/50/75%): os 4 tamanhos são sempre ancorados em pontos
 * economicamente relevantes (borda da banda, target, meio-termo, saída total). Ver
 * `moves/portfolio-move-generator.service.ts`. */
export type ReduceSizingStrategy = 'REDUCE_TO_UPPER_BAND' | 'REDUCE_PARTIAL' | 'REDUCE_TO_TARGET' | 'FULL_EXIT';

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
  /** Só presente em REDUCE/SELL gerados pelo branch sobrealocado do `generateB2`. */
  sizingStrategy?: ReduceSizingStrategy;
}

/**
 * REDUCE/SELL sempre passam (geram capital, nunca exigem); BUY/ADD_NEW_POSITION só passam se
 * couberem no capital disponível NESTE estado — nunca em `PortfolioMoveValidatorService`
 * (compartilhado com `generateB1`, que precisa mostrar a sugestão de aporte independente de caixa
 * pra reproduzir a matriz legada bit-a-bit) — aplicada só pelos consumidores B2/busca/Decision
 * Trace (ver achado do funding: `generateB2` não deve mais suprimir REDUCE por causa de caixa
 * baixo, mas também não pode deixar um BUY "gastar fiado").
 */
export function hasSufficientFunding(state: PortfolioState, move: PortfolioMove): boolean {
  if (move.type !== 'BUY' && move.type !== 'ADD_NEW_POSITION') return true;
  return move.amount <= availableToInvest(state.capital) + 1e-6;
}

/**
 * Tickers que aparecem como origem de uma venda (SELL/REDUCE) E como destino de uma compra
 * (BUY/ADD_NEW_POSITION) na MESMA linha — não importa a ordem (vende-depois-recompra ou
 * compra-depois-vende), nem se são adjacentes (reversão adjacente já é bloqueada por
 * `PortfolioCycleGuardService.isImmediateReversal`, que só olha o último move; este helper cobre
 * o caso não-adjacente, dentro da linha inteira). Usado pelo Comparator como guarda contra "vende
 * quase tudo, recompra quase tudo" ganhando só por ruído de arredondamento (achado real, Cenário
 * 5B da bateria de depth=3) — nunca decide sozinho, só desempata quando tudo mais já empatou.
 */
/**
 * Impressão digital determinística de UM move — usada pelo anti-stale check da execução real
 * (ver plano "Next Best Action"): o backend recalcula o Search no momento da execução (nunca
 * confia num move vindo do client) e compara essa fingerprint com a que o client confirmou. Já
 * usa `move.id` (embute type+setor+ticker) + quantidade/valor, pra pegar mudança de tamanho sem
 * precisar mudar de ticker/tipo.
 */
export function actionFingerprint(move: PortfolioMove): string {
  return `${move.id}::${move.quantity ?? 0}::${move.amount.toFixed(2)}`;
}

export function detectRoundTripSameTicker(moves: PortfolioMove[]): string[] {
  const vendidos = new Set<string>();
  const comprados = new Set<string>();
  for (const m of moves) {
    if ((m.type === 'SELL' || m.type === 'REDUCE') && m.sourceTicker) vendidos.add(m.sourceTicker);
    if ((m.type === 'BUY' || m.type === 'ADD_NEW_POSITION') && m.targetTicker) comprados.add(m.targetTicker);
  }
  return [...vendidos].filter((t) => comprados.has(t));
}
