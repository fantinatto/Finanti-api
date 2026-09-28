import { TipoCarteira } from '../../services/investimento.service';
import { PortfolioEvaluation } from './portfolio-evaluation';
import { PortfolioMove } from './portfolio-move';
import { PortfolioCapitalState } from './portfolio-state';
import { SearchResult } from './portfolio-search';
import { RebalanceToleranceMode, DynamicAllocationBandResult } from './dynamic-allocation-band';
import { CandidateOutcome, EvaluationCriterion } from './portfolio-explainability';
import { EntryStatus, OwnershipStatus, PolicyEligibility } from './recommendation-policy';

/** Bump manual sempre que a FORMA do payload ou a lógica de decisão do motor mudar de um jeito
 * que afete reprodutibilidade (ex: novo critério no Comparator, novo passo no MoveGenerator) —
 * pura convenção de auditoria, não amarra a nenhuma versão de pacote. */
export const RECOMMENDATION_ENGINE_VERSION = 'search-engine-v1-depth3-preview';

/**
 * Envelope FINO pra resposta HTTP do Preview — reaproveita os tipos de domínio já validados
 * (`PortfolioMove`, `PortfolioEvaluation`, `PortfolioCapitalState`, `RejectedAlternative`,
 * `EvaluationCriterion`, `DynamicAllocationBandResult`); só a FORMA da resposta é nova aqui.
 * `saleNotional`/`purchaseNotional`/`capitalBefore`/`capitalAfter` não existem no
 * `RecommendationPlanStep` do Decision Trace — são recalculados pelo
 * `RecommendationEngineService.getPreview()` reaplicando `bestLine.moves` via
 * `PortfolioStateTransitionService`, sem tocar no domínio do Decision Trace.
 */
export interface RecommendationPreviewStep {
  sequence: number;
  move: PortfolioMove;
  saleNotional: number;
  purchaseNotional: number;
  capitalBefore: PortfolioCapitalState;
  capitalAfter: PortfolioCapitalState;
  evaluationBefore: PortfolioEvaluation;
  evaluationAfter: PortfolioEvaluation;
  decidedBy: EvaluationCriterion;
  candidateOutcomes: CandidateOutcome[];
  bandaSetor?: DynamicAllocationBandResult;
}

/** Já vem da fronteira de Pareto deduplicada do Search Engine — nada aqui é "dominado" por
 * construção, não existe campo `dominated` (seria sempre `false`). */
export interface RecommendationPreviewAlternative {
  moves: PortfolioMove[];
  finalEvaluation: PortfolioEvaluation;
  turnover: number;
}

/** Ver plano "Next Best Action / Receding Horizon": só `nextBestAction` (steps[0]) é uma decisão
 * real — o resto da linha (`projectedPath`) é Principal Variation, a melhor PROJEÇÃO dado o
 * estado de HOJE, que deixa de valer assim que `nextBestAction` for executada de verdade (nova
 * carteira → novo snapshot → novo Search → nova `nextBestAction`, sem vínculo com a PV antiga). */
export interface PreviewBestPlan {
  steps: RecommendationPreviewStep[];
  /** = `steps[0]` — a ÚNICA ação com status de recomendação real; `null` quando o Search não
   * tem nenhum move admissível pra propor (ver `terminalReason`). */
  nextBestAction: RecommendationPreviewStep | null;
  /** `actionFingerprint(nextBestAction.move)` — o FRONT devolve isso tal qual em
   * `expectedActionFingerprint` na hora de executar. Ausente quando `nextBestAction === null`. */
  nextBestActionFingerprint?: string;
  /** = `steps.slice(1)` — projeção, nunca apresentar como plano já aprovado. */
  projectedPath: RecommendationPreviewStep[];
  /** Só presente quando `nextBestAction === null`. `NO_ADMISSIBLE_MOVE` = nenhum candidato
   * sequer foi gerado/passou nos gates (`searchMetadata.statesGenerated === 0`).
   * `STOP_SELECTED` = candidatos foram gerados e avaliados, mas o Comparator concluiu que
   * nenhum bate ficar parado — decisão ativa, não ausência de opção. */
  terminalReason?: 'NO_ADMISSIBLE_MOVE' | 'STOP_SELECTED';
  finalEvaluation: PortfolioEvaluation;
  turnover: number;
  capitalResidual: PortfolioCapitalState;
}

/** Agregado de candidatos que a RecommendationPolicy (Ownership+Entry Gate) excluiu ANTES de
 * virarem `PortfolioMove`, ao longo de toda a `bestLine` — nunca aparecem em
 * `RecommendationPreviewStep.candidateOutcomes` (nunca chegaram a ser candidato). */
export interface PolicyDiagnostics {
  totalExcluded: number;
  /** `OWNERSHIP_WEAK`/`ENTRY_EXPENSIVE` = `INELIGIBLE` (nunca seria comprável de jeito nenhum);
   * `FALLBACK_TO_ELIGIBLE` = era `ELIGIBLE`, mas perdeu pro fallback porque ≥1 `PREFERRED`
   * existia pra mesma necessidade (ver `partitionBySectorNeed`). */
  byReason: Record<'OWNERSHIP_WEAK' | 'ENTRY_EXPENSIVE' | 'FALLBACK_TO_ELIGIBLE', number>;
  perStep: {
    sequence: number;
    setor: string | null;
    excluded: { ticker: string; ownership: OwnershipStatus; entry: EntryStatus; eligibility: PolicyEligibility }[];
  }[];
}

export interface RecommendationPreviewResult {
  engineVersion: string;
  generatedAt: string;
  carteira: TipoCarteira;
  anoMes: string;
  snapshot: {
    portfolioValue: number;
    investedValue: number;
    availableCapital: number;
    rankingVersion: string;
    /** `economicStateHash` da raiz (ver `PortfolioStateHashService`) — o FRONT devolve isso tal
     * qual em `POST .../next-best-action/executar` (`expectedSnapshotHash`); o backend nunca
     * confia nele pra decidir nada, só compara com o que recalcula na hora de executar
     * (anti-stale, ver plano "Next Best Action"). */
    snapshotHash: string;
  };
  initialEvaluation: PortfolioEvaluation;
  bestPlan: PreviewBestPlan;
  policyDiagnostics: PolicyDiagnostics;
  alternatives: RecommendationPreviewAlternative[];
  searchMetadata: SearchResult['metadata'];
  config: {
    maxDepth: number;
    beamWidth: number;
    maxMovesPerNode: number;
    rebalanceToleranceMode: RebalanceToleranceMode;
    balanceMaterialityThresholdPp: number;
    engineVersion: string;
    rankingVersion: string;
  };
}
