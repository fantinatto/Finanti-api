import { Injectable } from '@nestjs/common';
import { PortfolioState } from '../domain/portfolio-state';
import { PortfolioMove } from '../domain/portfolio-move';
import { DEFAULT_SEGMENT_DIVERSIFICATION_CONFIG, SegmentDiversificationAssessment, SegmentDiversificationConfig } from '../domain/segment-diversification';
import { PortfolioStateTransitionService } from '../simulation/portfolio-state-transition.service';
import { PortfolioEvaluatorService } from '../evaluation/portfolio-evaluator.service';
import { LIMIAR_DIFERENCA_COVERAGE } from '../evaluation/portfolio-evaluation-comparator.service';

type Eixo = 'quality' | 'risk' | 'price';
const EIXOS: Eixo[] = ['quality', 'risk', 'price'];

/**
 * Guard de admissibilidade ESPECÍFICO pra candidatos `SEGMENT_CONCENTRATION` (Fase C.1) — achado
 * real (WLMM4/Bens Industriais, FESA4/Materiais Básicos): o branch de diversificação de segmento
 * excluía o segmento dominante sem nenhum piso de qualidade, deixando candidatos economicamente
 * fracos entrarem só por pertencerem a outro segmento. NÃO é o Comparator geral — só decide se
 * um candidato de diversificação sequer é ADMISSÍVEL, nunca qual candidato vence entre os
 * admissíveis (isso continua sendo só o Comparator).
 *
 * Critérios sempre relativos/de materialidade, nunca um piso absoluto de score (o ranking muda
 * de sentido por setor/mês/universo — ver plano).
 */
@Injectable()
export class SegmentDiversificationAdmissibilityService {
  constructor(
    private readonly transition: PortfolioStateTransitionService,
    private readonly evaluator: PortfolioEvaluatorService,
  ) {}

  /** `true` (sem assessment) pra qualquer move que não seja `SEGMENT_CONCENTRATION` — o guard só
   * se aplica a esse tipo específico de candidato. */
  isAdmissible(state: PortfolioState, move: PortfolioMove, config: SegmentDiversificationConfig = DEFAULT_SEGMENT_DIVERSIFICATION_CONFIG): boolean {
    if (move.primaryReason !== 'SEGMENT_CONCENTRATION') return true;
    return this.assess(state, move, config).admissible;
  }

  assess(state: PortfolioState, move: PortfolioMove, config: SegmentDiversificationConfig = DEFAULT_SEGMENT_DIVERSIFICATION_CONFIG): SegmentDiversificationAssessment {
    const setor = move.setor;
    const concentracaoAntes = state.segmentConcentration.find((s) => s.setor === setor);
    const segmentConcentrationBefore = concentracaoAntes?.maxSegmentShare ?? 0;

    const { state: nextState } = this.transition.apply(state, move);
    const concentracaoDepois = nextState.segmentConcentration.find((s) => s.setor === setor);
    const segmentConcentrationAfter = concentracaoDepois?.maxSegmentShare ?? 0;
    const concentrationImprovementPp = segmentConcentrationBefore - segmentConcentrationAfter;

    const antes = this.evaluator.evaluate(state);
    const depois = this.evaluator.evaluate(nextState);

    const ignoredDeteriorationAxes: Eixo[] = [];
    const maxDeteriorationPorEixo: Record<Eixo, number> = {
      quality: config.maxQualityDeteriorationDelta,
      risk: config.maxRiskDeteriorationDelta,
      price: config.maxPriceDeteriorationDelta,
    };

    let rejectionReason: SegmentDiversificationAssessment['rejectionReason'] = null;

    if (concentrationImprovementPp < config.minConcentrationImprovementPp) {
      rejectionReason = 'SEGMENT_DIVERSIFICATION_IMMATERIAL_BENEFIT';
    }

    for (const eixo of EIXOS) {
      const axAntes = antes.health.search[eixo];
      const axDepois = depois.health.search[eixo];
      if (Math.abs(axDepois.coverage - axAntes.coverage) > LIMIAR_DIFERENCA_COVERAGE) {
        ignoredDeteriorationAxes.push(eixo);
        continue;
      }
      if (axAntes.value == null || axDepois.value == null) continue;
      const deterioracao = axAntes.value - axDepois.value;
      if (!rejectionReason && deterioracao > maxDeteriorationPorEixo[eixo]) {
        rejectionReason = 'SEGMENT_DIVERSIFICATION_EXCESSIVE_HEALTH_DETERIORATION';
      }
    }

    const candidato = state.investmentUniverse.find((c) => c.ticker === (move.targetTicker ?? move.sourceTicker));
    const candidateScoreFinalDelta = candidato?.scoreFinalDelta ?? null;
    const doSetor = state.investmentUniverse.filter((c) => c.setor === setor && c.scoreFinalDelta != null);
    const bestSectorScoreFinalDelta = doSetor.length ? Math.max(...doSetor.map((c) => c.scoreFinalDelta as number)) : null;
    const relativeScoreRatio = candidateScoreFinalDelta != null && bestSectorScoreFinalDelta != null && bestSectorScoreFinalDelta > 0 ? candidateScoreFinalDelta / bestSectorScoreFinalDelta : null;

    if (!rejectionReason && relativeScoreRatio != null && relativeScoreRatio < config.minRelativeScoreRatio) {
      rejectionReason = 'SEGMENT_DIVERSIFICATION_LOW_RELATIVE_QUALITY';
    }

    return {
      admissible: rejectionReason === null,
      segmentConcentrationBefore,
      segmentConcentrationAfter,
      concentrationImprovementPp,
      qualityDeltaBefore: antes.health.search.quality.value,
      qualityDeltaAfter: depois.health.search.quality.value,
      riskDeltaBefore: antes.health.search.risk.value,
      riskDeltaAfter: depois.health.search.risk.value,
      priceDeltaBefore: antes.health.search.price.value,
      priceDeltaAfter: depois.health.search.price.value,
      ignoredDeteriorationAxes,
      candidateScoreFinalDelta,
      bestSectorScoreFinalDelta,
      relativeScoreRatio,
      rejectionReason,
    };
  }
}
