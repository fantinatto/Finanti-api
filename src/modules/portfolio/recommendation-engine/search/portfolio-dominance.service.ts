import { Injectable } from '@nestjs/common';
import { availableToInvest } from '../domain/portfolio-state';
import { PortfolioSearchNode } from '../domain/portfolio-search';
import { LIMIAR_DIFERENCA_COVERAGE } from '../evaluation/portfolio-evaluation-comparator.service';

const EPS = 1e-6;
/** % da `searchAllocationBase` acima da qual dois estados deixam de ter capital disponível
 * comparável — sem essa guarda, um estado "ponte" (SELL que ainda não reinvestiu, com caixa
 * alto) poderia ser podado só por ter Saúde/Balanceamento parecidos com outro estado que JÁ
 * reinvestiu, matando a chance da busca completar `SELL → BUY` no próximo passo. */
const LIMIAR_CAPITAL_COMPARAVEL_PCT = 0.02;

const EIXOS = ['quality', 'risk', 'price'] as const;

/**
 * Dominância Pareto formal entre dois nós de busca — A domina B quando A é ≤ B em violações/
 * desvio de balanceamento (base estável)/turnover acumulado, e ≥ B em cada eixo `search`
 * comparável (mesma regra de coverage do comparador), sendo estritamente melhor em pelo menos
 * uma dimensão. Se A domina B, B pode ser podado (não expandido) sem perda.
 */
@Injectable()
export class PortfolioDominanceService {
  domina(a: PortfolioSearchNode, b: PortfolioSearchNode): boolean {
    const capitalA = availableToInvest(a.state.capital);
    const capitalB = availableToInvest(b.state.capital);
    const epsilonCapital = a.state.searchAllocationBase * LIMIAR_CAPITAL_COMPARAVEL_PCT;
    if (Math.abs(capitalA - capitalB) > epsilonCapital) return false; // não comparáveis — nenhum lado poda o outro

    const hvA = a.evaluation.balance.hardViolations.length;
    const hvB = b.evaluation.balance.hardViolations.length;
    if (hvA > hvB) return false;

    const devA = a.evaluation.balance.totalSectorDeviation;
    const devB = b.evaluation.balance.totalSectorDeviation;
    if (devA > devB + EPS) return false;

    if (a.cumulativeTurnover > b.cumulativeTurnover + EPS) return false;

    let estritamenteMelhorEmAlgo = hvA < hvB || devA < devB - EPS || a.cumulativeTurnover < b.cumulativeTurnover - EPS;

    for (const eixo of EIXOS) {
      const axA = a.evaluation.health.search[eixo];
      const axB = b.evaluation.health.search[eixo];
      if (Math.abs(axA.coverage - axB.coverage) > LIMIAR_DIFERENCA_COVERAGE) continue; // eixo incomparável, ignora
      if (axA.value == null || axB.value == null) continue;
      if (axA.value < axB.value - EPS) return false; // A pior nesse eixo -> não domina
      if (axA.value > axB.value + EPS) estritamenteMelhorEmAlgo = true;
    }

    return estritamenteMelhorEmAlgo;
  }

  /** Remove da lista qualquer nó dominado por outro nó DA MESMA LISTA — O(n²), aceitável pro
   * tamanho de beam usado nesta fase. */
  removerDominados(nodes: PortfolioSearchNode[]): PortfolioSearchNode[] {
    return nodes.filter((candidato) => !nodes.some((outro) => outro !== candidato && this.domina(outro, candidato)));
  }
}
