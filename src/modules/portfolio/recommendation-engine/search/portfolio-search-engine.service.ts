import { Injectable } from '@nestjs/common';
import { PortfolioState } from '../domain/portfolio-state';
import { detectRoundTripSameTicker, hasSufficientFunding, PortfolioMove, RankingConfidence } from '../domain/portfolio-move';
import { DEFAULT_SEARCH_CONFIG, PortfolioSearchConfig, PortfolioSearchNode, SearchLine, SearchResult } from '../domain/portfolio-search';
import { PortfolioMoveGeneratorService } from '../moves/portfolio-move-generator.service';
import { PortfolioMoveValidatorService } from '../moves/portfolio-move-validator.service';
import { PortfolioStateTransitionService } from '../simulation/portfolio-state-transition.service';
import { PortfolioEvaluatorService } from '../evaluation/portfolio-evaluator.service';
import { CandidatoParaComparar, PortfolioEvaluationComparatorService } from '../evaluation/portfolio-evaluation-comparator.service';
import { PortfolioCycleGuardService } from './portfolio-cycle-guard.service';
import { PortfolioMoveOrderingService } from './portfolio-move-ordering.service';
import { PortfolioDominanceService } from './portfolio-dominance.service';
import { PortfolioStateHashService } from './portfolio-state-hash.service';
import { PortfolioTranspositionTableService } from './portfolio-transposition-table.service';
import { SegmentDiversificationAdmissibilityService } from '../segment-diversification/segment-diversification-admissibility.service';

/**
 * Beam search por profundidade sobre PortfolioState, reaproveitando os componentes já validados
 * de A/B1/B2 (Generator.generateB2, Validator, StateTransition, Evaluator, Comparator). Ver plano
 * da Fase C, seção 6.
 *
 * Dois conjuntos SEPARADOS (ajuste 2 do usuário): `terminalCandidates` recebe TODO nó visitado,
 * incondicionalmente — é dele que sai o resultado final (STOP nunca é eliminado por dominância
 * contra seus próprios filhos). `expandableFrontier` é a única coisa podada/beamada pra decidir
 * o que continua sendo expandido — a poda ali NUNCA remove nada de `terminalCandidates`.
 */
@Injectable()
export class PortfolioSearchEngineService {
  constructor(
    private readonly generator: PortfolioMoveGeneratorService,
    private readonly validator: PortfolioMoveValidatorService,
    private readonly transition: PortfolioStateTransitionService,
    private readonly evaluator: PortfolioEvaluatorService,
    private readonly comparator: PortfolioEvaluationComparatorService,
    private readonly cycleGuard: PortfolioCycleGuardService,
    private readonly ordering: PortfolioMoveOrderingService,
    private readonly dominance: PortfolioDominanceService,
    private readonly hasher: PortfolioStateHashService,
    private readonly segmentDiversificationAdmissibility: SegmentDiversificationAdmissibilityService,
  ) {}

  search(initialState: PortfolioState, config: PortfolioSearchConfig = DEFAULT_SEARCH_CONFIG): SearchResult {
    const startTime = Date.now();
    let statesGenerated = 0;
    let statesEvaluated = 0;
    let statesPruned = 0;
    let transpositionHits = 0;

    const evaluationCache = new Map<string, ReturnType<PortfolioEvaluatorService['evaluate']>>();
    const transpositionTable = new PortfolioTranspositionTableService();

    const rootHash = this.hasher.economicStateHash(initialState);
    const rootEvaluation = this.evaluator.evaluate(initialState);
    evaluationCache.set(rootHash, rootEvaluation);
    const raiz: PortfolioSearchNode = {
      state: initialState,
      evaluation: rootEvaluation,
      history: [],
      depth: 0,
      cumulativeTurnover: 0,
      economicStateHash: rootHash,
      searchNodeHash: rootHash,
    };

    const terminalCandidates: PortfolioSearchNode[] = [raiz];
    let expandableFrontier: PortfolioSearchNode[] = [raiz];
    let depthReached = 0;
    let limiteAtingido = false;

    for (let depth = 1; depth <= config.maxDepth && !limiteAtingido; depth++) {
      const proximaFronteira: PortfolioSearchNode[] = [];

      for (const no of expandableFrontier) {
        if (limiteAtingido) break;

        let moves = this.generator.generateB2(no.state).moves;
        moves = moves.filter((m) => this.validator.validate(no.state, m));
        moves = moves.filter((m) => hasSufficientFunding(no.state, m));
        moves = moves.filter((m) => this.segmentDiversificationAdmissibility.isAdmissible(no.state, m));
        moves = moves.filter((m) => !this.cycleGuard.isImmediateReversal(no.history, m));
        moves = this.ordering.order(no.state, moves, rootEvaluation, { diversityAware: config.diversityAwareOrdering }).slice(0, config.maxMovesPerNode);

        for (const move of moves) {
          if (statesGenerated >= config.maxStatesGenerated) {
            limiteAtingido = true;
            break;
          }
          statesGenerated++;

          const { state: nextState, saleNotional, purchaseNotional } = this.transition.apply(no.state, move);
          const economicHash = this.hasher.economicStateHash(nextState);
          const searchHash = this.hasher.searchNodeHash(nextState, move);
          const cumulativeTurnover = no.cumulativeTurnover + saleNotional + purchaseNotional;

          let evaluation = evaluationCache.get(economicHash);
          if (!evaluation) {
            evaluation = this.evaluator.evaluate(nextState);
            evaluationCache.set(economicHash, evaluation);
            statesEvaluated++;
          }

          const { podeExpandir, hit } = transpositionTable.considerar(economicHash, evaluation, cumulativeTurnover, depth);
          if (hit) transpositionHits++;

          const filho: PortfolioSearchNode = {
            state: nextState,
            evaluation,
            history: [...no.history, move],
            depth,
            cumulativeTurnover,
            economicStateHash: economicHash,
            searchNodeHash: searchHash,
          };

          terminalCandidates.push(filho); // SEMPRE — ver ajuste 2
          if (podeExpandir) proximaFronteira.push(filho);
        }
      }

      const antesDaPoda = proximaFronteira.length;
      const naoDominados = this.dominance.removerDominados(proximaFronteira);
      statesPruned += antesDaPoda - naoDominados.length;

      naoDominados.sort((a, b) => this.compararNos(a, b));
      expandableFrontier = naoDominados.slice(0, config.beamWidth);
      depthReached = depth;

      if (expandableFrontier.length === 0) break; // nada mais pra expandir
    }

    // Fronteira de Pareto real dos terminais (ajuste 6) — dedupe por economicStateHash mantendo
    // o de menor turnover (empate: menor número de moves).
    const melhorPorEstado = new Map<string, PortfolioSearchNode>();
    for (const t of terminalCandidates) {
      const existente = melhorPorEstado.get(t.economicStateHash);
      if (
        !existente ||
        t.cumulativeTurnover < existente.cumulativeTurnover - 1e-6 ||
        (Math.abs(t.cumulativeTurnover - existente.cumulativeTurnover) <= 1e-6 && t.history.length < existente.history.length)
      ) {
        melhorPorEstado.set(t.economicStateHash, t);
      }
    }
    const terminaisUnicos = [...melhorPorEstado.values()];
    const paretoFrontier = terminaisUnicos.filter((t) => !terminaisUnicos.some((outro) => outro !== t && this.dominance.domina(outro, t)));
    paretoFrontier.sort((a, b) => this.compararNos(a, b));

    const bestNode = paretoFrontier[0] ?? raiz;
    const alternativeNodes = paretoFrontier.slice(1, 6);

    return {
      bestLine: this.paraLinha(bestNode, rootEvaluation),
      alternatives: alternativeNodes.map((n) => this.paraLinha(n, rootEvaluation)),
      metadata: {
        depthReached,
        statesGenerated,
        statesEvaluated,
        statesPruned,
        transpositionHits,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private compararNos(a: PortfolioSearchNode, b: PortfolioSearchNode): number {
    const resultado = this.comparator.compare(this.candidatoParaComparar(a), this.candidatoParaComparar(b));
    if (resultado.vencedor === 'a') return -1;
    if (resultado.vencedor === 'b') return 1;
    return 0;
  }

  private candidatoParaComparar(node: PortfolioSearchNode): CandidatoParaComparar {
    const ultimoMove: PortfolioMove | undefined = node.history[node.history.length - 1];
    const ticker = ultimoMove ? (ultimoMove.targetTicker ?? ultimoMove.sourceTicker) : undefined;
    const scoreFinalResultante = ticker
      ? (node.state.investmentUniverse.find((c) => c.ticker === ticker)?.scoreFinal ?? node.state.positions.find((p) => p.ticker === ticker)?.scoreFinal ?? null)
      : null;
    const confidence: RankingConfidence = ultimoMove?.confidence ?? 'HIGH';
    return {
      evaluation: node.evaluation,
      amount: node.cumulativeTurnover,
      confidence,
      scoreFinalResultante,
      roundTripDetected: detectRoundTripSameTicker(node.history).length > 0,
    };
  }

  private paraLinha(node: PortfolioSearchNode, rootEvaluation: ReturnType<PortfolioEvaluatorService['evaluate']>): SearchLine {
    return {
      moves: node.history,
      initialEvaluation: rootEvaluation,
      finalEvaluation: node.evaluation,
      cumulativeTurnover: node.cumulativeTurnover,
      cumulativeEstimatedTax: null,
      finalStateHash: node.economicStateHash,
    };
  }
}
