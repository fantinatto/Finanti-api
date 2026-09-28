import { PortfolioEvaluation } from './portfolio-evaluation';
import { PortfolioMove } from './portfolio-move';
import { SearchLine } from './portfolio-search';
import { DynamicAllocationBandResult } from './dynamic-allocation-band';
import { CriterioDecisao } from '../evaluation/portfolio-evaluation-comparator.service';
import { SegmentDiversificationRejectionReason } from './segment-diversification';
import { PolicyExclusion } from './recommendation-policy';

/** Reexport com o nome que o usuário pediu — mesmo enum de critérios que já decide vencedores no
 * comparador (Fase B2), agora também usado pra EXPLICAR por que um candidato perdeu. */
export type EvaluationCriterion = CriterioDecisao;

/**
 * Ciclo de vida real de um candidato dentro de UM passo do Decision Trace — distingue "nunca
 * competiu" de "competiu e perdeu" (achado real: `PortfolioDecisionTraceService` rotulava TODO
 * candidato não-vencedor como "rejeitado por X", mesmo quando X (`comparator.compare`) nunca
 * chegou a rodar entre ele e o vencedor de verdade — casos cortados por `MoveOrdering`/
 * `maxMovesPerNode` apareciam como "rejeitado por balance" quando na real nunca foram avaliados,
 * e teriam vencido uma comparação justa).
 */
export type CandidateLifecycle =
  | 'INVALID' // gerado, mas reprovado por Validator/funding/CycleGuard — nunca chega a ordering
  | 'MOVE_ORDERING_CUT' // válido, mas fora do top `maxMovesPerNode` naquele nó — NUNCA chega ao Comparator
  | 'EVALUATED' // entrou no corte, foi transicionado+avaliado, perdeu no Comparator
  | 'DOMINATED' // entrou no corte, foi avaliado, removido pela Dominância Pareto (nunca chega ao Comparator)
  | 'SELECTED' // o vencedor real deste passo
  /** Reservados — exigiriam reconstruir a árvore de busca INTEIRA daquele nível (todos os nós
   * concorrentes de `expandableFrontier`, não só os da linha vencedora), contradizendo o design
   * do Decision Trace (só replaya a linha vencedora, barato). Nunca emitidos hoje — documentado
   * como limitação conhecida, não fabricar um valor aproximado. */
  | 'TRANSPOSITION_REJECTED'
  | 'BEAM_PRUNED';

export interface CandidateOutcome {
  move: PortfolioMove;
  lifecycle: CandidateLifecycle;
  /** Só presente quando `lifecycle` é `EVALUATED`/`SELECTED` — só nesses casos o Comparator
   * realmente rodou entre este candidato e o vencedor. `null` em qualquer outro lifecycle,
   * mesmo que pareça "óbvio" qual critério teria decidido — nunca inferir. */
  decidedBy: EvaluationCriterion | null;
  /** Posição no ranking de `MoveOrdering` ANTES do corte de `maxMovesPerNode` (0-indexado) — só
   * pra candidatos que chegaram a ser ordenados (não `INVALID`). */
  orderingRank?: number;
  /** Só presente quando o candidato chegou a ser transicionado+avaliado (`EVALUATED`/
   * `DOMINATED`/`SELECTED`) — nos outros lifecycles não existe estado resultante pra avaliar. */
  evaluation?: PortfolioEvaluation;
  /** Só presente quando `lifecycle === 'INVALID'`. */
  invalidReason?: 'VALIDATOR' | 'INSUFFICIENT_FUNDING' | 'CYCLE_REVERSAL' | SegmentDiversificationRejectionReason;
}

export interface RecommendationPlanStep {
  sequence: number;
  move: PortfolioMove;
  beforeEvaluation: PortfolioEvaluation;
  afterEvaluation: PortfolioEvaluation;
  /** Critério que decidiu o vencedor frente ao MELHOR entre os candidatos genuinamente
   * `EVALUATED` (a comparação mais apertada de verdade) — responde "por que esta e não a 2ª
   * colocada", nunca considerando candidatos `MOVE_ORDERING_CUT`/`DOMINATED`/`INVALID` (esses
   * nunca chegaram a competir, não têm `decidedBy` real). */
  decidedBy: EvaluationCriterion;
  /** TODO candidato gerado neste passo, com seu lifecycle real — inclui o próprio `SELECTED`
   * (não é só "os rejeitados"). */
  candidateOutcomes: CandidateOutcome[];
  /** Banda dinâmica do setor tocado pelo move, no momento deste passo — só preenchido em modo
   * `DYNAMIC_PRICE` (ver "Estouro Dinâmico"); `undefined` em modo `FIXED` ou quando o move não
   * tem um setor associado. */
  bandaSetor?: DynamicAllocationBandResult;
  /** Candidatos que a RecommendationPolicy (Ownership+Entry Gate) excluiu ANTES de virarem
   * `PortfolioMove` neste passo — nunca aparecem em `candidateOutcomes` (nunca chegaram a ser
   * candidato), mas ficam registrados aqui pra explainability agregada (ver Preview/
   * `policyDiagnostics`). */
  policyExclusions: PolicyExclusion[];
}

export interface DecisionTrace {
  steps: RecommendationPlanStep[];
  finalLine: SearchLine;
}
