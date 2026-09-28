import { Injectable } from '@nestjs/common';
import { PortfolioEvaluation, SearchHealthAxis } from '../domain/portfolio-evaluation';
import { PortfolioMove } from '../domain/portfolio-move';
import { PortfolioState } from '../domain/portfolio-state';

type Eixo = 'quality' | 'risk' | 'price';

/**
 * Só eficiência — NUNCA decide o vencedor (isso é sempre `PortfolioEvaluationComparatorService`).
 * Ordem heurística: 1) REDUCE/SELL em setor sobrealocado 2) ROTATE_WITHIN_SECTOR 3) BUY/
 * ADD_NEW_POSITION em setor subalocado 4) dentro de cada tier, prioriza quem melhora mais o eixo
 * mais deficitário do ESTADO INICIAL da busca (`state0`) — aqui SIM é permitido (e recomendado)
 * usar `state0` como âncora, porque isso só afeta em qual ORDEM os candidatos são tentados, não
 * qual estado final vence (ver plano da Fase C, seção 0.1: o comparador não pode fixar `state0`,
 * mas o ordering pode, já que é só uma heurística de busca).
 */
export interface OrderOptions {
  /** Default `false` — preserva o comportamento de hoje. Quando `true`, depois do sort por
   * tier+score, uma repartição ESTÁVEL bubbla o PRIMEIRO candidato de cada "família" pra frente
   * (preservando a ordem relativa dentro de cada família e entre famílias já vistas) — sem isso,
   * o Move Sizing (até 4 tamanhos por posição em REDUCE/SELL) deixa um único ticker ocupar boa
   * parte do orçamento de `maxMovesPerNode` sozinho, cortando candidatos de OUTROS tickers/
   * setores que nunca chegam a competir de verdade (achado real — ver plano). Não remove
   * nenhuma variante do pool, só reordena. */
  diversityAware?: boolean;
}

@Injectable()
export class PortfolioMoveOrderingService {
  order(state: PortfolioState, moves: PortfolioMove[], initialEvaluation: PortfolioEvaluation, options?: OrderOptions): PortfolioMove[] {
    const eixoDeficitario = this.eixoMaisDeficitario(initialEvaluation);

    const tier = (m: PortfolioMove): number => {
      if (m.type === 'SELL' || m.type === 'REDUCE') return 0;
      if (m.type === 'ROTATE_WITHIN_SECTOR') return 1;
      return 2; // BUY | ADD_NEW_POSITION
    };

    const scoreOrdem = (m: PortfolioMove): number => {
      const ticker = m.targetTicker ?? m.sourceTicker;
      const deltaEixo = this.deltaDoEixo(state, ticker, eixoDeficitario);
      const bonusConfidence = m.confidence === 'HIGH' ? 0.01 : 0; // desempate leve, não decide sozinho
      return deltaEixo + bonusConfidence;
    };

    const ordenados = [...moves].sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      if (ta !== tb) return ta - tb;
      return scoreOrdem(b) - scoreOrdem(a);
    });

    if (!options?.diversityAware) return ordenados;

    // REDUCE/SELL: família = ticker de origem (as até 4 variantes de sizing do MESMO ticker não
    // ocupam o orçamento sozinhas). BUY/ADD_NEW_POSITION: família = setor de destino (um único
    // setor subalocado com muitos candidatos diversificados não domina o orçamento).
    const familyKeyDe = (m: PortfolioMove): string => (m.type === 'SELL' || m.type === 'REDUCE' ? `ticker:${m.sourceTicker}` : `setor:${m.setor}`);

    const vistos = new Set<string>();
    const primeiraRodada: PortfolioMove[] = [];
    const restante: PortfolioMove[] = [];
    for (const m of ordenados) {
      const key = familyKeyDe(m);
      if (!vistos.has(key)) {
        vistos.add(key);
        primeiraRodada.push(m);
      } else {
        restante.push(m);
      }
    }
    return [...primeiraRodada, ...restante];
  }

  private eixoMaisDeficitario(evaluation: PortfolioEvaluation): Eixo {
    const deficit = (axis: SearchHealthAxis) => (axis.value == null ? 0 : Math.max(0, 1.5 - axis.value));
    const eixos: Eixo[] = ['risk', 'quality', 'price'];
    let melhor: Eixo = eixos[0];
    let maiorDeficit = -Infinity;
    for (const eixo of eixos) {
      const d = deficit(evaluation.health.search[eixo]);
      if (d > maiorDeficit) { maiorDeficit = d; melhor = eixo; }
    }
    return melhor;
  }

  private deltaDoEixo(state: PortfolioState, ticker: string | undefined, eixo: Eixo): number {
    if (!ticker) return 0;
    const candidato = state.investmentUniverse.find((c) => c.ticker === ticker) ?? state.positions.find((p) => p.ticker === ticker);
    if (!candidato) return 0;
    if (eixo === 'quality') return candidato.qualidadeDelta ?? 0;
    if (eixo === 'risk') return candidato.riscoDelta ?? 0;
    return candidato.precoDelta ?? 0;
  }
}
