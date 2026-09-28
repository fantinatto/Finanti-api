import { Injectable } from '@nestjs/common';
import { PortfolioState } from '../domain/portfolio-state';
import { PortfolioMove } from '../domain/portfolio-move';

/**
 * Hash determinístico de estado — dois caminhos que chegam ao mesmo patrimônio produzem o mesmo
 * `economicStateHash`. Ver plano da Fase C, seção 4: DOIS hashes com propósitos diferentes.
 */
@Injectable()
export class PortfolioStateHashService {
  /** Só patrimônio — posições (ticker+quantidade, ordenadas por ticker pra determinismo),
   * capital (arredondado a centavos) e rankingVersion. Usado pro cache de avaliação, pra dedupe
   * da fronteira de Pareto terminal, e como chave da transposition table. */
  economicStateHash(state: PortfolioState): string {
    const posicoes = [...state.positions]
      .sort((a, b) => a.ticker.localeCompare(b.ticker))
      .map((p) => `${p.ticker}:${p.quantidade.toFixed(4)}`)
      .join('|');
    const capital = `${state.capital.existingCash.toFixed(2)}:${state.capital.externalContributionBudget.toFixed(2)}:${state.capital.proceedsGeneratedByPlan.toFixed(2)}`;
    return `${state.rankingVersion}::${posicoes}::${capital}`;
  }

  /** economicStateHash + assinatura do ÚLTIMO move aplicado — usado só pra decidir se vale a
   * pena CONTINUAR expandindo um nó (ver PortfolioTranspositionTableService/CycleGuard): dois
   * caminhos podem chegar ao mesmo patrimônio com o último move diferente, e o CycleGuard só
   * olha o último move pra bloquear reversões — dedupe só pelo economicStateHash arriscaria
   * podar um nó cujo próximo passo (bloqueado no outro caminho) ainda seria válido aqui. */
  searchNodeHash(state: PortfolioState, ultimoMove: PortfolioMove | null): string {
    const base = this.economicStateHash(state);
    if (!ultimoMove) return base;
    return `${base}::${ultimoMove.type}:${ultimoMove.sourceTicker ?? ''}>${ultimoMove.targetTicker ?? ''}`;
  }
}
