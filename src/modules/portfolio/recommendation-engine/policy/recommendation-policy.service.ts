import { Injectable } from '@nestjs/common';
import { InvestmentCandidateMetadata } from '../domain/portfolio-state';
import {
  DEFAULT_RECOMMENDATION_POLICY_CONFIG,
  InvestmentPolicyAssessment,
  PolicyEligibility,
  RecommendationPolicyConfig,
} from '../domain/recommendation-policy';

/**
 * Ownership Gate (Qualidade+Risco) + Entry Gate (Preço) — ver domain/recommendation-policy.ts.
 * Pura, sem I/O — só lê os campos já calculados em `InvestmentCandidateMetadata`.
 */
@Injectable()
export class RecommendationPolicyService {
  assess(candidate: InvestmentCandidateMetadata, config: RecommendationPolicyConfig = DEFAULT_RECOMMENDATION_POLICY_CONFIG): InvestmentPolicyAssessment {
    const quality = candidate.scoreQualidade;
    const risk = candidate.riscoComposto;
    const price = candidate.precoDelta;

    const ownershipStrong = quality != null && quality >= config.qualityStrongMin && risk != null && risk >= config.riskStrongMin;
    const ownershipWeak = (quality != null && quality < config.qualityWeakFloor) || (risk != null && risk < config.riskWeakFloor);
    const ownership: InvestmentPolicyAssessment['ownership'] = ownershipStrong
      ? { quality, risk, status: 'STRONG', reasons: ['STRONG_ON_BOTH_AXES'] }
      : ownershipWeak
        ? {
            quality,
            risk,
            status: 'WEAK',
            reasons: [
              ...(quality != null && quality < config.qualityWeakFloor ? (['QUALITY_BELOW_WEAK_FLOOR'] as const) : []),
              ...(risk != null && risk < config.riskWeakFloor ? (['RISK_BELOW_WEAK_FLOOR'] as const) : []),
            ],
          }
        : { quality, risk, status: 'ACCEPTABLE', reasons: ['ACCEPTABLE'] };

    const entry: InvestmentPolicyAssessment['entry'] =
      price != null && price >= config.entryAttractiveMin
        ? { price, status: 'ATTRACTIVE', reasons: ['AT_OR_ABOVE_ATTRACTIVE_THRESHOLD'] }
        : price != null && price <= config.entryExpensiveMax
          ? { price, status: 'EXPENSIVE', reasons: ['AT_OR_BELOW_EXPENSIVE_THRESHOLD'] }
          : { price, status: 'NEUTRAL', reasons: ['BELOW_ATTRACTIVE_THRESHOLD'] };

    let eligibility: PolicyEligibility;
    if (ownership.status === 'WEAK' || entry.status === 'EXPENSIVE') {
      eligibility = 'INELIGIBLE';
    } else if (entry.status === 'ATTRACTIVE') {
      eligibility = 'PREFERRED';
    } else {
      eligibility = 'ELIGIBLE';
    }

    return {
      ownership,
      entry,
      eligibility,
      fundamentalExitPriority: ownership.status === 'WEAK' ? 'HIGH' : 'NONE',
      scoreFinal: candidate.scoreFinal,
    };
  }

  /**
   * Recebe a lista JÁ UNIFICADA de candidatos de UMA necessidade (nunca dividida por tipo de
   * move — BUY vs ADD_NEW_POSITION — antes de chamar isso, senão MILS3 poderia escapar da
   * concorrência direta com POMO3 por um sub-branch separado que não existe de propósito).
   * PREFERRED tem precedência de verdade sobre ELIGIBLE: se ≥1 candidato é PREFERRED, só eles
   * são admitidos; senão, os ELIGIBLE; INELIGIBLE nunca é admitido.
   */
  partitionBySectorNeed(
    candidatos: InvestmentCandidateMetadata[],
    config: RecommendationPolicyConfig = DEFAULT_RECOMMENDATION_POLICY_CONFIG,
  ): {
    admitidos: InvestmentCandidateMetadata[];
    excluidos: { candidato: InvestmentCandidateMetadata; assessment: InvestmentPolicyAssessment }[];
  } {
    const avaliados = candidatos.map((candidato) => ({ candidato, assessment: this.assess(candidato, config) }));
    const preferidos = avaliados.filter((a) => a.assessment.eligibility === 'PREFERRED');
    const elegiveis = avaliados.filter((a) => a.assessment.eligibility === 'ELIGIBLE');
    const ineligiveis = avaliados.filter((a) => a.assessment.eligibility === 'INELIGIBLE');

    const admitidosAvaliados = preferidos.length ? preferidos : elegiveis;
    const excluidosAvaliados = preferidos.length ? [...elegiveis, ...ineligiveis] : ineligiveis;

    return {
      admitidos: admitidosAvaliados.map((a) => a.candidato),
      excluidos: excluidosAvaliados.map((a) => ({ candidato: a.candidato, assessment: a.assessment })),
    };
  }
}
