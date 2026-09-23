/**
 * Fator de penalização de liquidez — aplicado ao scoreFinal/scoreFinalDelta (não aos
 * sub-scores Qualidade/Risco/Preço, que são diagnóstico fundamentalista puro, ortogonal a
 * quão fácil é comprar/vender o papel). Testado em 2026-09-23 contra o caso real SOND3:
 * liquidezmediadiaria de R$ 3.866/dia (o próprio "mico" que motivou essa penalização) vs.
 * VIVT4/CURY3 na casa de R$ 100M-2B/dia — a escala logarítmica de zonas abaixo reflete essa
 * diferença de ordens de grandeza sem criar um degrau abrupto único.
 *
 * ATENÇÃO: liquidezmediadiaria vem ausente (undefined) da Status Invest pra ~24% do universo,
 * INCLUSIVE blue chips confirmadas líquidas (VIVT4, R$98bi de market cap, sem esse campo na
 * fonte ao vivo). É bug de cobertura da fonte, não sinal de iliquidez — por isso null aqui
 * SEMPRE retorna fator 1.0 (sem penalização), nunca o pior caso. Mesmo princípio já usado no
 * resto do motor: dado ausente é tratado como desconhecido, não como "assume o pior".
 */
export function calcularFatorLiquidez(liquidezMediaDiaria: number | null | undefined): number {
  if (liquidezMediaDiaria == null) return 1.0;
  if (liquidezMediaDiaria >= 1_000_000) return 1.0;
  if (liquidezMediaDiaria >= 500_000) return 0.9;
  if (liquidezMediaDiaria >= 100_000) return 0.7;
  if (liquidezMediaDiaria >= 20_000) return 0.4;
  return 0.1;
}
