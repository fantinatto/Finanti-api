import { PortfolioEvaluation } from '../domain/portfolio-evaluation';

interface TranspositionEntry {
  evaluation: PortfolioEvaluation;
  cumulativeTurnover: number;
  depth: number;
}

export interface ConsiderarResultado {
  /** false = já existe um caminho igual ou melhor pro MESMO estado econômico — não vale a pena
   * continuar expandindo este nó (a árvore de fato encolhe, não só a avaliação). */
  podeExpandir: boolean;
  hit: boolean;
}

/**
 * Chave sempre `economicStateHash` (nunca `searchNodeHash`) — é aqui que a árvore de busca
 * realmente encolhe, resolvendo o problema de "hoje só economiza Evaluator, o nó duplicado
 * continua sendo expandido" (ver plano da Fase C, seção 4).
 *
 * NÃO é registrado como provider do Nest — tem estado por busca (`tabela`), então
 * `PortfolioSearchEngineService` instancia um `new PortfolioTranspositionTableService()` a cada
 * chamada de `search()`, em vez de injetar um singleton que vazaria estado entre buscas
 * diferentes.
 */
export class PortfolioTranspositionTableService {
  private tabela = new Map<string, TranspositionEntry>();

  considerar(hash: string, evaluation: PortfolioEvaluation, cumulativeTurnover: number, depth: number): ConsiderarResultado {
    const existente = this.tabela.get(hash);
    if (!existente) {
      this.tabela.set(hash, { evaluation, cumulativeTurnover, depth });
      return { podeExpandir: true, hit: false };
    }
    if (existente.depth <= depth && existente.cumulativeTurnover <= cumulativeTurnover) {
      return { podeExpandir: false, hit: true };
    }
    // Caminho novo chega mais raso e/ou com menos turnover — substitui o registro.
    this.tabela.set(hash, { evaluation, cumulativeTurnover, depth });
    return { podeExpandir: true, hit: true };
  }

  reset(): void {
    this.tabela.clear();
  }
}
