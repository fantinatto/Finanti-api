import { Injectable } from '@nestjs/common';
import { PortfolioEvaluation, SearchHealthAxis } from '../domain/portfolio-evaluation';
import { RankingConfidence } from '../domain/portfolio-move';

type Eixo = 'quality' | 'risk' | 'price';
export type CriterioDecisao = 'hardViolations' | 'balance' | 'dominance' | 'deficientAxis' | 'otherAxes' | 'confidence' | 'turnover' | 'tie';

export interface CandidatoParaComparar {
  evaluation: PortfolioEvaluation;
  amount: number;
  confidence: RankingConfidence;
  scoreFinalResultante: number | null;
}

export interface ResultadoComparacao {
  vencedor: 'a' | 'b' | 'tie';
  decidiuPor: CriterioDecisao;
  /** Eixos onde a diferença de coverage entre os dois candidatos impediu comparar o value com
   * confiança (ver plano, ajuste 9) — auditável, não bloqueia a decisão, só pula esse eixo. */
  ignoredCoverageShiftAxes: Eixo[];
}

const NEUTRO = 1.5;
/** Diferença de coverage acima da qual dois candidatos deixam de ser comparáveis naquele eixo —
 * a "melhora" observada pode vir de qual posição ficou de fora da média, não de risco/qualidade/
 * preço real. Ver plano, ajuste 9. */
const LIMIAR_DIFERENCA_COVERAGE = 0.01;
/** Ordem de desempate quando dois+ eixos empatam em distância do neutro — arbitrária mas
 * documentada (não é um peso, só resolve empate exato, o que é raro com valores reais). */
const ORDEM_DESEMPATE_EIXO: Eixo[] = ['risk', 'quality', 'price'];

/**
 * Ordem lexicográfica formal (ver plano, ajuste 7) — nunca uma média ponderada. Cada critério só
 * decide se os anteriores empataram. compare(a,b) < 0 significa "a é melhor que b".
 */
@Injectable()
export class PortfolioEvaluationComparatorService {
  compare(before: PortfolioEvaluation, a: CandidatoParaComparar, b: CandidatoParaComparar): ResultadoComparacao {
    const ignoredCoverageShiftAxes: Eixo[] = [];

    // 1. Violações — sempre vazio nesta fase (ver Fase A), mas o critério já existe pra a Fase E
    // não precisar mexer no comparador de novo.
    const hvA = a.evaluation.balance.hardViolations.length;
    const hvB = b.evaluation.balance.hardViolations.length;
    if (hvA !== hvB) return { vencedor: hvA < hvB ? 'a' : 'b', decidiuPor: 'hardViolations', ignoredCoverageShiftAxes };

    // 2. Balanceamento — nenhum candidato pode piorar o desvio total do setor.
    const devA = a.evaluation.balance.totalSectorDeviation;
    const devB = b.evaluation.balance.totalSectorDeviation;
    if (Math.abs(devA - devB) > 1e-6) return { vencedor: devA < devB ? 'a' : 'b', decidiuPor: 'balance', ignoredCoverageShiftAxes };

    // 3. Dominância parcial Qualidade/Risco/Preço (Pareto), só entre eixos com coverage comparável.
    let aMelhorEmAlgum = false;
    let aPiorEmAlgum = false;
    for (const eixo of ORDEM_DESEMPATE_EIXO) {
      const axA = a.evaluation.health.search[eixo];
      const axB = b.evaluation.health.search[eixo];
      if (Math.abs(axA.coverage - axB.coverage) > LIMIAR_DIFERENCA_COVERAGE) {
        ignoredCoverageShiftAxes.push(eixo);
        continue;
      }
      if (axA.value == null || axB.value == null) continue;
      if (axA.value > axB.value) aMelhorEmAlgum = true;
      if (axA.value < axB.value) aPiorEmAlgum = true;
    }
    if (aMelhorEmAlgum && !aPiorEmAlgum) return { vencedor: 'a', decidiuPor: 'dominance', ignoredCoverageShiftAxes };
    if (aPiorEmAlgum && !aMelhorEmAlgum) return { vencedor: 'b', decidiuPor: 'dominance', ignoredCoverageShiftAxes };

    // 4. Trade-off real (A melhor em 1 eixo, pior em outro) — prioriza o eixo mais distante de
    // 1,5 (neutro) no estado ATUAL, antes de qualquer move.
    if (aMelhorEmAlgum && aPiorEmAlgum) {
      const distancia = (axis: SearchHealthAxis) => (axis.value == null ? -Infinity : Math.abs(axis.value - NEUTRO));
      let eixoDeficitario: Eixo = ORDEM_DESEMPATE_EIXO[0];
      let maiorDistancia = -Infinity;
      for (const eixo of ORDEM_DESEMPATE_EIXO) {
        const d = distancia(before.health.search[eixo]);
        if (d > maiorDistancia) { maiorDistancia = d; eixoDeficitario = eixo; }
      }
      if (!ignoredCoverageShiftAxes.includes(eixoDeficitario)) {
        const axA = a.evaluation.health.search[eixoDeficitario];
        const axB = b.evaluation.health.search[eixoDeficitario];
        if (axA.value != null && axB.value != null && Math.abs(axA.value - axB.value) > 1e-9) {
          return { vencedor: axA.value > axB.value ? 'a' : 'b', decidiuPor: 'deficientAxis', ignoredCoverageShiftAxes };
        }
      }

      // 5. Demais eixos — soma das diferenças (ainda comparação, não média ponderada arbitrária).
      let somaA = 0, somaB = 0;
      for (const eixo of ORDEM_DESEMPATE_EIXO) {
        if (ignoredCoverageShiftAxes.includes(eixo)) continue;
        const axA = a.evaluation.health.search[eixo];
        const axB = b.evaluation.health.search[eixo];
        if (axA.value == null || axB.value == null) continue;
        somaA += axA.value;
        somaB += axB.value;
      }
      if (Math.abs(somaA - somaB) > 1e-9) return { vencedor: somaA > somaB ? 'a' : 'b', decidiuPor: 'otherAxes', ignoredCoverageShiftAxes };
    }

    // 6. RankingConfidence / Score Final do ticker resultante.
    if (a.confidence !== b.confidence) return { vencedor: a.confidence === 'HIGH' ? 'a' : 'b', decidiuPor: 'confidence', ignoredCoverageShiftAxes };
    if (a.scoreFinalResultante != null && b.scoreFinalResultante != null && Math.abs(a.scoreFinalResultante - b.scoreFinalResultante) > 1e-9) {
      return { vencedor: a.scoreFinalResultante > b.scoreFinalResultante ? 'a' : 'b', decidiuPor: 'confidence', ignoredCoverageShiftAxes };
    }

    // 7. Turnover — menor valor movimentado vence (substitui o desempate de compatibilidade da
    // B1, que era "maior |valorSugerido|" — válido só pra reproduzir o sistema legado).
    if (Math.abs(a.amount - b.amount) > 1e-6) return { vencedor: a.amount < b.amount ? 'a' : 'b', decidiuPor: 'turnover', ignoredCoverageShiftAxes };

    return { vencedor: 'tie', decidiuPor: 'tie', ignoredCoverageShiftAxes };
  }
}
