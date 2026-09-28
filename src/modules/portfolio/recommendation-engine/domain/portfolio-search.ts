import { PortfolioEvaluation } from './portfolio-evaluation';
import { PortfolioMove } from './portfolio-move';
import { PortfolioState } from './portfolio-state';

export interface PortfolioSearchConfig {
  maxDepth: number;
  beamWidth: number;
  maxMovesPerNode: number;
  /** Contra ESTE contador que o loop testa (nós GERADOS, não avaliados — cache hit não é uma
   * nova avaliação). Renomeado de `maxStatesEvaluated` a pedido do usuário, pra não confundir a
   * métrica reportada (`statesEvaluated`, cache misses reais) com o limite de segurança. */
  maxStatesGenerated: number;
  /** Default `false` — preserva o comportamento de hoje. Quando `true`, `MoveOrdering` garante
   * que o orçamento de `maxMovesPerNode` se distribui entre "famílias" de candidato (1 por
   * ticker de origem em REDUCE/SELL, 1 por setor de destino em BUY/ADD) antes de preencher com
   * as próximas melhores variantes — evita que o Move Sizing (até 4 tamanhos por posição) deixe
   * um único ticker ocupar o orçamento sozinho (achado real: SAPR4 nunca foi avaliado porque as
   * 4 variantes de CMIG4 ocuparam a maior parte do corte). Ver
   * `search/portfolio-move-ordering.service.ts`. */
  diversityAwareOrdering?: boolean;
}

export const DEFAULT_SEARCH_CONFIG: PortfolioSearchConfig = {
  maxDepth: 2,
  beamWidth: 20,
  maxMovesPerNode: 6,
  maxStatesGenerated: 5000,
  diversityAwareOrdering: false,
};

export interface PortfolioSearchNode {
  state: PortfolioState;
  evaluation: PortfolioEvaluation;
  /** Moves desde o estado inicial, na ordem aplicada — guardado direto (sem ponteiro-pai) pra
   * simplicidade; custo desprezível com maxDepth pequeno. */
  history: PortfolioMove[];
  depth: number;
  /** Soma de `saleNotional + purchaseNotional` de cada move da linha (turnover efetivo — ver
   * PortfolioStateTransitionService), não a soma ingênua de `move.amount`. */
  cumulativeTurnover: number;
  /** Só patrimônio (posições + capital + rankingVersion) — usado pro cache de avaliação e pra
   * dedupe da fronteira de Pareto terminal. */
  economicStateHash: string;
  /** economicStateHash + assinatura do último move — usado só pra decidir se vale a pena
   * CONTINUAR expandindo (dois caminhos podem chegar ao mesmo patrimônio com contextos de
   * CycleGuard diferentes). */
  searchNodeHash: string;
}

export interface SearchLine {
  moves: PortfolioMove[];
  initialEvaluation: PortfolioEvaluation;
  finalEvaluation: PortfolioEvaluation;
  cumulativeTurnover: number;
  /** Reservado pra Fase E (sequenciamento fiscal-aware usando o módulo Fiscal já existente) —
   * sempre null nesta fase, não fabricar valor. */
  cumulativeEstimatedTax: null;
  finalStateHash: string;
}

export interface SearchResult {
  bestLine: SearchLine;
  /** Fronteira de Pareto real dos estados terminais, excluindo a bestLine (ver
   * PortfolioSearchEngineService) — não só "não dominados pela bestLine". */
  alternatives: SearchLine[];
  metadata: {
    depthReached: number;
    statesGenerated: number;
    /** Cache misses reais — métrica, não limite (ver maxStatesGenerated). */
    statesEvaluated: number;
    statesPruned: number;
    transpositionHits: number;
    durationMs: number;
  };
}
