import { Injectable } from '@nestjs/common';
import { PortfolioState } from '../domain/portfolio-state';
import { PortfolioEvaluation } from '../domain/portfolio-evaluation';
import { detectRoundTripSameTicker, hasSufficientFunding, PortfolioMove, RankingConfidence } from '../domain/portfolio-move';
import { PortfolioSearchConfig, PortfolioSearchNode, SearchLine } from '../domain/portfolio-search';
import { CandidateOutcome, DecisionTrace, EvaluationCriterion, RecommendationPlanStep } from '../domain/portfolio-explainability';
import { PortfolioMoveGeneratorService } from '../moves/portfolio-move-generator.service';
import { PortfolioMoveValidatorService } from '../moves/portfolio-move-validator.service';
import { PortfolioStateTransitionService } from '../simulation/portfolio-state-transition.service';
import { PortfolioEvaluatorService } from '../evaluation/portfolio-evaluator.service';
import { CandidatoParaComparar, PortfolioEvaluationComparatorService } from '../evaluation/portfolio-evaluation-comparator.service';
import { PortfolioCycleGuardService } from '../search/portfolio-cycle-guard.service';
import { PortfolioMoveOrderingService } from '../search/portfolio-move-ordering.service';
import { PortfolioDominanceService } from '../search/portfolio-dominance.service';
import { PortfolioStateHashService } from '../search/portfolio-state-hash.service';
import { SegmentDiversificationAdmissibilityService } from '../segment-diversification/segment-diversification-admissibility.service';

/** Ordem dos critérios do comparador, do mais "grosseiro" (decide cedo, corta muitos candidatos
 * de uma vez) ao mais "apertado" (só decide quando tudo antes empatou). Usada só pra escolher,
 * entre os candidatos genuinamente EVALUATED de um passo, qual foi o mais próximo de vencer —
 * nunca decide vencedor nenhum, isso já foi feito pelo comparador de verdade. */
const ORDEM_CRITERIOS: EvaluationCriterion[] = [
  'hardViolations',
  'balance',
  'segmentConcentration',
  'roundTripPenalty',
  'maxDeficit',
  'sumDeficit',
  'dominance',
  'confidence',
  'turnover',
  'tie',
];

interface CandidatoAvaliado {
  move: PortfolioMove;
  state: PortfolioState;
  evaluation: PortfolioEvaluation;
  turnover: number;
  orderingRank: number;
}

/**
 * Reconstrói, passo a passo, POR QUE a linha vencedora de `PortfolioSearchEngineService.search`
 * venceu — refazendo o MESMO pipeline Generator→Validator→funding→CycleGuard→MoveOrdering→
 * (corte de maxMovesPerNode)→StateTransition→Evaluator→Dominance→Comparator já validado, em vez
 * de instrumentar o loop de busca (que não deve ser tocado só por um requisito de
 * explicabilidade). Barato: só `bestLine.moves.length` chamadas, não a árvore inteira.
 *
 * Ponto crítico (achado real — ver plano "Decision Trace: lifecycle real"): candidatos cortados
 * por `MoveOrdering`/`maxMovesPerNode` NUNCA chegam ao Comparator na busca real — rotulá-los como
 * "rejeitados por X" seria factualmente errado (alguns teriam vencido uma comparação justa). Por
 * isso este serviço reproduz o MESMO corte (`searchConfig.maxMovesPerNode`/`diversityAwareOrdering`)
 * antes de decidir quem teve chance de competir.
 */
@Injectable()
export class PortfolioDecisionTraceService {
  constructor(
    private readonly generator: PortfolioMoveGeneratorService,
    private readonly validator: PortfolioMoveValidatorService,
    private readonly cycleGuard: PortfolioCycleGuardService,
    private readonly ordering: PortfolioMoveOrderingService,
    private readonly dominance: PortfolioDominanceService,
    private readonly hasher: PortfolioStateHashService,
    private readonly transition: PortfolioStateTransitionService,
    private readonly evaluator: PortfolioEvaluatorService,
    private readonly comparator: PortfolioEvaluationComparatorService,
    private readonly segmentDiversificationAdmissibility: SegmentDiversificationAdmissibilityService,
  ) {}

  build(initialState: PortfolioState, rootEvaluation: PortfolioEvaluation, bestLine: SearchLine, searchConfig: PortfolioSearchConfig): DecisionTrace {
    let currentState = initialState;
    let currentEvaluation = rootEvaluation;
    let history: PortfolioMove[] = [];
    let cumulativeTurnover = 0;
    const steps: RecommendationPlanStep[] = [];

    for (const move of bestLine.moves) {
      const { moves: todosCandidatos, policyExclusions } = this.generator.generateB2(currentState);

      const outcomes: CandidateOutcome[] = [];
      const validos: PortfolioMove[] = [];
      for (const m of todosCandidatos) {
        const assessmentDiversificacao = m.primaryReason === 'SEGMENT_CONCENTRATION' ? this.segmentDiversificationAdmissibility.assess(currentState, m) : null;

        if (!this.validator.validate(currentState, m)) {
          outcomes.push({ move: m, lifecycle: 'INVALID', decidedBy: null, invalidReason: 'VALIDATOR' });
        } else if (!hasSufficientFunding(currentState, m)) {
          outcomes.push({ move: m, lifecycle: 'INVALID', decidedBy: null, invalidReason: 'INSUFFICIENT_FUNDING' });
        } else if (assessmentDiversificacao && !assessmentDiversificacao.admissible) {
          outcomes.push({ move: m, lifecycle: 'INVALID', decidedBy: null, invalidReason: assessmentDiversificacao.rejectionReason ?? undefined });
        } else if (this.cycleGuard.isImmediateReversal(history, m)) {
          outcomes.push({ move: m, lifecycle: 'INVALID', decidedBy: null, invalidReason: 'CYCLE_REVERSAL' });
        } else {
          validos.push(m);
        }
      }

      const ordenados = this.ordering.order(currentState, validos, rootEvaluation, { diversityAware: searchConfig.diversityAwareOrdering });
      const expandidos = ordenados.slice(0, searchConfig.maxMovesPerNode);
      const cortados = ordenados.slice(searchConfig.maxMovesPerNode);
      for (let i = 0; i < cortados.length; i++) {
        outcomes.push({ move: cortados[i], lifecycle: 'MOVE_ORDERING_CUT', decidedBy: null, orderingRank: searchConfig.maxMovesPerNode + i });
      }

      const avaliados: CandidatoAvaliado[] = expandidos.map((m, i) => {
        const { state, saleNotional, purchaseNotional } = this.transition.apply(currentState, m);
        const evaluation = this.evaluator.evaluate(state);
        return { move: m, state, evaluation, turnover: cumulativeTurnover + saleNotional + purchaseNotional, orderingRank: i };
      });

      const nos: (PortfolioSearchNode & { origem: CandidatoAvaliado })[] = avaliados.map((a) => ({
        state: a.state,
        evaluation: a.evaluation,
        history: [...history, a.move],
        depth: history.length + 1,
        cumulativeTurnover: a.turnover,
        economicStateHash: this.hasher.economicStateHash(a.state),
        searchNodeHash: this.hasher.searchNodeHash(a.state, a.move),
        origem: a,
      }));

      const naoDominados = new Set(this.dominance.removerDominados(nos));
      for (const no of nos) {
        if (!naoDominados.has(no)) {
          outcomes.push({ move: no.origem.move, lifecycle: 'DOMINATED', decidedBy: null, orderingRank: no.origem.orderingRank, evaluation: no.origem.evaluation });
        }
      }

      const sobreviventes: CandidatoAvaliado[] = nos.filter((no) => naoDominados.has(no)).map((no) => no.origem);
      const vencedorIdx = sobreviventes.findIndex((c) => c.move.id === move.id);
      if (vencedorIdx === -1) {
        // Não deveria acontecer (mesmo pipeline que gerou bestLine) — encerra o trace aqui em vez
        // de quebrar, mantendo os passos já reconstruídos válidos.
        break;
      }
      const vencedor = sobreviventes[vencedorIdx];
      const outrosSobreviventes = sobreviventes.filter((_, i) => i !== vencedorIdx);

      const candidatoDe = (c: CandidatoAvaliado) => this.candidatoParaComparar(c.move, c.state, c.evaluation, c.turnover, history);
      const candidatoVencedor = candidatoDe(vencedor);

      const decisoesEvaluated: { criterio: EvaluationCriterion }[] = [];
      for (const o of outrosSobreviventes) {
        const criterio = this.comparator.compare(candidatoVencedor, candidatoDe(o)).decidiuPor;
        outcomes.push({ move: o.move, lifecycle: 'EVALUATED', decidedBy: criterio, orderingRank: o.orderingRank, evaluation: o.evaluation });
        decisoesEvaluated.push({ criterio });
      }
      outcomes.push({ move: vencedor.move, lifecycle: 'SELECTED', decidedBy: null, orderingRank: vencedor.orderingRank, evaluation: vencedor.evaluation });

      const decidedBy = decisoesEvaluated.length ? this.criterioMaisApertado(decisoesEvaluated.map((d) => d.criterio)) : 'tie';
      // Vazio em modo FIXED (`dynamicAllocationBands=[]`) — `find` retorna `undefined` sozinho.
      const bandaSetor = move.setor ? currentState.dynamicAllocationBands.find((b) => b.setor === move.setor) : undefined;

      steps.push({
        sequence: steps.length + 1,
        move,
        beforeEvaluation: currentEvaluation,
        afterEvaluation: vencedor.evaluation,
        decidedBy,
        candidateOutcomes: outcomes,
        bandaSetor,
        policyExclusions,
      });

      currentState = vencedor.state;
      currentEvaluation = vencedor.evaluation;
      history = [...history, move];
      cumulativeTurnover = vencedor.turnover;
    }

    return { steps, finalLine: bestLine };
  }

  /** Critério que decidiu a comparação MAIS apertada entre os candidatos genuinamente
   * `EVALUATED` — o cujo critério está mais "no fundo" da ordem do comparador (mais perto de
   * empatar de vez com o vencedor). Nunca considera `MOVE_ORDERING_CUT`/`DOMINATED`/`INVALID` —
   * esses não têm um critério real (é exatamente o achado que motivou esta reescrita). */
  private criterioMaisApertado(criterios: EvaluationCriterion[]): EvaluationCriterion {
    return criterios.reduce((maisApertado, c) => (ORDEM_CRITERIOS.indexOf(c) > ORDEM_CRITERIOS.indexOf(maisApertado) ? c : maisApertado), criterios[0]);
  }

  private candidatoParaComparar(move: PortfolioMove, state: PortfolioState, evaluation: PortfolioEvaluation, turnover: number, historicoAteAqui: PortfolioMove[]): CandidatoParaComparar {
    const ticker = move.targetTicker ?? move.sourceTicker;
    const scoreFinalResultante = ticker
      ? (state.investmentUniverse.find((c) => c.ticker === ticker)?.scoreFinal ?? state.positions.find((p) => p.ticker === ticker)?.scoreFinal ?? null)
      : null;
    const confidence: RankingConfidence = move.confidence;
    const roundTripDetected = detectRoundTripSameTicker([...historicoAteAqui, move]).length > 0;
    return { evaluation, amount: turnover, confidence, scoreFinalResultante, roundTripDetected };
  }
}
