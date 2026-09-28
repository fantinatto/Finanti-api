import { InvestmentCandidateMetadata } from './portfolio-state';

/** Amostra mínima de tickers com Preço/Qualidade/Risco calculável pra confiar na atratividade
 * relativa de um setor — mesmo espírito de `QTD_MINIMA_SEGMENTO` (ranking-query.service.ts).
 * Abaixo disso, a banda dinâmica cai em fallback (ver `DynamicAllocationBandService`). */
export const QTD_MINIMA_AMOSTRA_PRECO_SETOR = 3;

/** Preço/Qualidade/Risco agregados de um setor — driver da banda dinâmica de rebalanceamento
 * (Preço) e guardrail (Qualidade/Risco). Média dos Δ (não do score clássico) dos top-3 tickers
 * do setor por Score Final — MESMA metodologia do gráfico "Comparativo entre setores"
 * (`RankingQueryService.getTop3PorGrupo`), só que lida direto de `investmentUniverse` (já
 * carregado no snapshot, zero query nova) em vez de reconsultar o score clássico. */
export interface SectorMarketState {
  setor: string;
  amostra: number;
  precoDeltaMedio: number | null;
  qualidadeDeltaMedio: number | null;
  riscoDeltaMedio: number | null;
}

/** Função pura: `investmentUniverse` (já carregado no snapshot) -> `SectorMarketState[]`. Nenhuma
 * query — reaproveita exatamente os Δ que o resto do motor (Health/SearchBalance/Comparator) já
 * trata como fonte de verdade, em vez de reintroduzir o sistema de score clássico só pra isso. */
export function computeSectorMarketStates(investmentUniverse: InvestmentCandidateMetadata[]): SectorMarketState[] {
  const porSetor = new Map<string, InvestmentCandidateMetadata[]>();
  for (const c of investmentUniverse) {
    if (!c.setor || c.scoreFinal == null) continue;
    if (!porSetor.has(c.setor)) porSetor.set(c.setor, []);
    porSetor.get(c.setor)!.push(c);
  }

  const media = (valores: (number | null)[]): number | null => {
    const validos = valores.filter((v): v is number => v != null);
    return validos.length ? validos.reduce((acc, v) => acc + v, 0) / validos.length : null;
  };

  const resultado: SectorMarketState[] = [];
  for (const [setor, candidatos] of porSetor) {
    const top3 = [...candidatos].sort((a, b) => (b.scoreFinal ?? -Infinity) - (a.scoreFinal ?? -Infinity)).slice(0, 3);
    resultado.push({
      setor,
      amostra: top3.length,
      precoDeltaMedio: top3.length >= QTD_MINIMA_AMOSTRA_PRECO_SETOR ? media(top3.map((c) => c.precoDelta)) : null,
      qualidadeDeltaMedio: top3.length >= QTD_MINIMA_AMOSTRA_PRECO_SETOR ? media(top3.map((c) => c.qualidadeDelta)) : null,
      riscoDeltaMedio: top3.length >= QTD_MINIMA_AMOSTRA_PRECO_SETOR ? media(top3.map((c) => c.riscoDelta)) : null,
    });
  }
  return resultado;
}
