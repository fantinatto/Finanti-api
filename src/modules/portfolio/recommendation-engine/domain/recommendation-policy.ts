/**
 * Camada econômica compartilhável (Ownership Gate + Entry Gate) — extraída do B1
 * (`investimento.service.ts`), mas SEM a lógica estrutural/apresentação/sequenciamento de lá.
 * Responde 2 perguntas SEPARADAS (nunca uma só via `scoreFinal` combinado — é exatamente o que
 * essa camada existe pra não fazer):
 * - Ownership (Qualidade+Risco): "quero ser sócio dessa empresa?" — decide se o ativo merece
 *   existir na carteira, independente de preço.
 * - Entry (Preço): "faz sentido colocar capital novo nela AGORA?" — decide só o momento de
 *   entrada, nunca a permanência (preço caro nunca vira sinal de venda de uma empresa boa).
 * `scoreFinal` some dos dois gates — só entra depois, pra ORDENAR quem já passou (ver
 * `RecommendationPolicyService`).
 */
export type OwnershipStatus = 'STRONG' | 'ACCEPTABLE' | 'WEAK';
export type EntryStatus = 'ATTRACTIVE' | 'NEUTRAL' | 'EXPENSIVE';
export type PolicyEligibility = 'INELIGIBLE' | 'ELIGIBLE' | 'PREFERRED';

export interface RecommendationPolicyConfig {
  /** Piso de Qualidade pra Ownership `STRONG` — reusa `QUALIDADE_SAUDAVEL_MIN`
   * (`normalizer.ts`), já validado ali pra decidir "qualidade saudável" no value-trap de P/L. */
  qualityStrongMin: number;
  /** Piso de Risco (`riscoComposto`) pra Ownership `STRONG` — reusa `RISCO_SAUDAVEL_MIN`
   * (`normalizer.ts`), já validado ali pro value-trap de P/VP. */
  riskStrongMin: number;
  /** Piso de Qualidade abaixo do qual Ownership é `WEAK` — reusa
   * `CORTE_QUALIDADE_SPLIT_APORTE_PADRAO` (`investimento.service.ts`, B1). */
  qualityWeakFloor: number;
  /** Piso de Risco abaixo do qual Ownership é `WEAK` — NOVO, proposto, sem equivalente validado
   * hoje em nenhum lugar do motor; precisa de shadow comparison antes de qualquer promoção. */
  riskWeakFloor: number;
  /** Δ de Preço mínimo pra Entry `ATTRACTIVE` — NOVO, proposto (neutro 1.5 já é o ponto de
   * referência usado em `PortfolioMoveOrderingService.eixoMaisDeficitario`, só a banda em volta
   * dele é nova). */
  entryAttractiveMin: number;
  /** Δ de Preço máximo pra Entry `EXPENSIVE` — NOVO, proposto, mesma lógica em espelho. */
  entryExpensiveMax: number;
}

export const DEFAULT_RECOMMENDATION_POLICY_CONFIG: RecommendationPolicyConfig = {
  qualityStrongMin: 1.0,
  riskStrongMin: 2.0,
  qualityWeakFloor: 0.5,
  riskWeakFloor: 1.0,
  entryAttractiveMin: 1.75,
  entryExpensiveMax: 1.25,
};

export interface OwnershipAssessment {
  quality: number | null;
  risk: number | null;
  status: OwnershipStatus;
  reasons: ('QUALITY_BELOW_WEAK_FLOOR' | 'RISK_BELOW_WEAK_FLOOR' | 'STRONG_ON_BOTH_AXES' | 'ACCEPTABLE')[];
}

export interface EntryAssessment {
  price: number | null;
  status: EntryStatus;
  reasons: ('BELOW_ATTRACTIVE_THRESHOLD' | 'AT_OR_ABOVE_ATTRACTIVE_THRESHOLD' | 'AT_OR_BELOW_EXPENSIVE_THRESHOLD')[];
}

/** Diagnóstico agregado, NUNCA gera/bloqueia SELL/REDUCE sozinho nesta rodada — REDUCE
 * estrutural (setor sobrealocado) continua sempre mecanicamente válido, independente disso.
 * `HIGH` só reflete mérito econômico ruim (Ownership `WEAK`), nunca preço caro isolado — uma
 * empresa ótima que ficou cara é `NONE` aqui (HOLD, não candidata a venda). */
export type FundamentalExitPriority = 'HIGH' | 'NONE';

export interface InvestmentPolicyAssessment {
  ownership: OwnershipAssessment;
  entry: EntryAssessment;
  /** Elegibilidade de COMPRA/APORTE (BUY/ADD_NEW_POSITION) — derivada só de ownership+entry. */
  eligibility: PolicyEligibility;
  fundamentalExitPriority: FundamentalExitPriority;
  /** Carregado só pra ORDENAR candidatos dentro do mesmo `eligibility` — nunca re-entra em
   * nenhuma conta de ownership/entry/eligibility (sem super-score). */
  scoreFinal: number | null;
}

/** Candidato considerado por `generateB2` mas que nunca virou `PortfolioMove` (INELIGIBLE, ou
 * ELIGIBLE cortado pelo fallback de PREFERRED) — explainability agregada (Decision Trace/
 * Preview), nunca ruído de `PortfolioMove`. */
export interface PolicyExclusion {
  ticker: string;
  setor: string | null;
  segmento: string | null;
  assessment: InvestmentPolicyAssessment;
}
