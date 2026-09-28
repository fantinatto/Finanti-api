export interface SegmentDiversificationConfig {
  /** pp — abaixo disso, o ganho de concentração é considerado imaterial (Caso C do pedido). */
  minConcentrationImprovementPp: number;
  /** Escala Δ (0-3) — queda máxima tolerada no eixo, portfolio inteiro, antes/depois do move. */
  maxQualityDeteriorationDelta: number;
  maxRiskDeteriorationDelta: number;
  maxPriceDeteriorationDelta: number;
  /** candidateScoreFinalDelta / bestSectorScoreFinalDelta — NUNCA um piso absoluto, sempre
   * relativo ao melhor candidato ECONÔMICO disponível no mesmo setor naquele mês/universo (evita
   * `scoreFinal >= X` fixo, que varia de sentido por setor/mês — ver pedido do usuário). */
  minRelativeScoreRatio: number;
}

export const DEFAULT_SEGMENT_DIVERSIFICATION_CONFIG: SegmentDiversificationConfig = {
  minConcentrationImprovementPp: 5,
  maxQualityDeteriorationDelta: 0.1,
  maxRiskDeteriorationDelta: 0.1,
  maxPriceDeteriorationDelta: 0.1,
  minRelativeScoreRatio: 0.75,
};

export type SegmentDiversificationRejectionReason =
  | 'SEGMENT_DIVERSIFICATION_IMMATERIAL_BENEFIT'
  | 'SEGMENT_DIVERSIFICATION_EXCESSIVE_HEALTH_DETERIORATION'
  | 'SEGMENT_DIVERSIFICATION_LOW_RELATIVE_QUALITY';

/** Auditoria completa de UM candidato `SEGMENT_CONCENTRATION` — nunca decide sozinha (isso é o
 * `SegmentDiversificationAdmissibilityService`), só expõe os números que sustentam a decisão,
 * pro Decision Trace conseguir explicar por que um candidato de diversificação foi barrado. */
export interface SegmentDiversificationAssessment {
  admissible: boolean;
  segmentConcentrationBefore: number;
  segmentConcentrationAfter: number;
  concentrationImprovementPp: number;
  qualityDeltaBefore: number | null;
  qualityDeltaAfter: number | null;
  riskDeltaBefore: number | null;
  riskDeltaAfter: number | null;
  priceDeltaBefore: number | null;
  priceDeltaAfter: number | null;
  /** eixos ignorados no critério de deterioração por causa de shift de coverage (mesma
   * filosofia do Comparator — cobertura baixa nunca faz um candidato "parecer melhor"). */
  ignoredDeteriorationAxes: ('quality' | 'risk' | 'price')[];
  candidateScoreFinalDelta: number | null;
  bestSectorScoreFinalDelta: number | null;
  relativeScoreRatio: number | null;
  rejectionReason: SegmentDiversificationRejectionReason | null;
}
