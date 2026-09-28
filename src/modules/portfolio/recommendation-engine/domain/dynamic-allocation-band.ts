export type RebalanceToleranceMode = 'FIXED' | 'DYNAMIC_PRICE';

export interface DynamicRebalanceConfig {
  maxAdjustment: number;
  guardrailEnabled: boolean;
}

export const DEFAULT_DYNAMIC_REBALANCE_CONFIG: DynamicRebalanceConfig = {
  maxAdjustment: 2,
  guardrailEnabled: true,
};

/** Auditoria completa de UM setor sob a banda dinâmica — o que sustenta o Decision Trace
 * explicar "por que esse setor foi considerado subalocado/sobrealocado". `target`/`baseTolerance`
 * nunca mudam por preço (o estratégico é fixo) — só `min`/`max`/`status` reagem. */
export interface DynamicAllocationBandResult {
  setor: string;
  target: number;
  baseTolerance: number;
  /** [-1,+1] — null quando não há amostra de Preço confiável esse mês (fallback). */
  priceAttractiveness: number | null;
  /** 0 quando fallback, `target===0`, ou o guardrail neutralizou a parte positiva. */
  dynamicAdjustment: number;
  lowerTolerance: number;
  upperTolerance: number;
  min: number;
  max: number;
  status: 'sobrealocado' | 'subalocado' | 'equilibrado';
  /** true quando Qualidade/Risco do setor não sustentavam a expansão positiva que o Preço sozinho
   * pediria — nunca restringe o lado negativo (setor caro ganhando tolerância pra subalocação). */
  guardrailApplied: boolean;
  fallbackReason: 'INSUFFICIENT_PRICE_DATA' | null;
}
