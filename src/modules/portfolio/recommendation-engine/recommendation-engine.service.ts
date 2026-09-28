import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  CategoriaAcao,
  PRIORIDADE_POR_CATEGORIA,
  PrioridadeAcao,
  RecomendacaoHolding,
  TipoCarteira,
} from '../services/investimento.service';
import { SimulacaoService } from '../services/simulacao.service';
import { PortfolioSnapshotService } from './snapshot/portfolio-snapshot.service';
import { PortfolioEvaluatorService } from './evaluation/portfolio-evaluator.service';
import { CandidatoParaComparar, CriterioDecisao, DEFAULT_BALANCE_MATERIALITY_THRESHOLD_PP, PortfolioEvaluationComparatorService } from './evaluation/portfolio-evaluation-comparator.service';
import { CandidateSeedConfig, PortfolioMoveGeneratorService } from './moves/portfolio-move-generator.service';
import { PortfolioMoveValidatorService } from './moves/portfolio-move-validator.service';
import { PortfolioStateTransitionService } from './simulation/portfolio-state-transition.service';
import { PortfolioSearchEngineService } from './search/portfolio-search-engine.service';
import { PortfolioStateHashService } from './search/portfolio-state-hash.service';
import { PortfolioDecisionTraceService } from './explainability/portfolio-decision-trace.service';
import { actionFingerprint, detectRoundTripSameTicker, hasSufficientFunding, PortfolioMove } from './domain/portfolio-move';
import { availableToInvest, PortfolioPositionState, PortfolioState } from './domain/portfolio-state';
import { DEFAULT_SEARCH_CONFIG } from './domain/portfolio-search';
import { PolicyDiagnostics, RECOMMENDATION_ENGINE_VERSION, RecommendationPreviewResult, RecommendationPreviewStep } from './domain/portfolio-preview';
import { SegmentDiversificationAdmissibilityService } from './segment-diversification/segment-diversification-admissibility.service';

/** Um candidato avaliado dentro de uma necessidade (setor + tipo) — expõe o move, o estado
 * resultante e a avaliação, pra auditoria (por que o vencedor venceu). */
export interface CandidatoAvaliadoB2 {
  move: PortfolioMove;
  evaluation: ReturnType<PortfolioEvaluatorService['evaluate']>;
}

export interface EscolhaB2 {
  setor: string;
  necessidade: 'sobrealocado' | 'subalocado';
  candidatos: CandidatoAvaliadoB2[];
  vencedor: PortfolioMove | null;
  decidiuPor: CriterioDecisao | null;
  ignoredCoverageShiftAxes: string[];
}

/**
 * Orquestra Snapshot -> MoveGenerator -> Validator -> conversão pro shape RecomendacaoHolding já
 * existente. Deliberadamente PARALELO a `InvestimentoService.getRecomendacoes` nesta fase (B1/B2)
 * — não substitui/chama o método antigo, nem é chamado por ele — pra permitir comparar os dois
 * outputs sem risco de regressão no endpoint já em produção (ver plano, verificação da Fase B1).
 */
@Injectable()
export class RecommendationEngineService {
  constructor(
    private readonly snapshotService: PortfolioSnapshotService,
    private readonly evaluatorService: PortfolioEvaluatorService,
    private readonly comparatorService: PortfolioEvaluationComparatorService,
    private readonly moveGenerator: PortfolioMoveGeneratorService,
    private readonly moveValidator: PortfolioMoveValidatorService,
    private readonly transitionService: PortfolioStateTransitionService,
    private readonly searchEngine: PortfolioSearchEngineService,
    private readonly decisionTrace: PortfolioDecisionTraceService,
    private readonly segmentDiversificationAdmissibility: SegmentDiversificationAdmissibilityService,
    private readonly hasher: PortfolioStateHashService,
    private readonly simulacaoService: SimulacaoService,
  ) {}

  async getRecomendacoesB1(userId: string, anoMes: string, carteira: TipoCarteira): Promise<RecomendacaoHolding[]> {
    const state = await this.snapshotService.build(userId, anoMes, carteira);
    const { moves, suppressedByAvailableCash, legacyCarryForwardSuggestions } = this.moveGenerator.generateB1(state);
    const movesValidos = moves.filter((m) => this.moveValidator.validate(state, m));
    return this.converterParaRecomendacoes(state, movesValidos, suppressedByAvailableCash, legacyCarryForwardSuggestions);
  }

  /**
   * Adapter LEGADO — só existe pra reproduzir `InvestimentoService.getRecomendacoes` bit-a-bit
   * (Fase B1). `legacyCarryForwardSuggestions` é consumido SÓ aqui, nunca por `PortfolioMove`/
   * `StateTransition`/comparador (B2 em diante) — mantém a peculiaridade de compatibilidade
   * isolada do domínio novo, a pedido do usuário.
   */
  private converterParaRecomendacoes(
    state: PortfolioState,
    moves: PortfolioMove[],
    suppressedByAvailableCash: Set<string>,
    legacyCarryForwardSuggestions: Map<string, { amount: number; quantity: number | null }>,
  ): RecomendacaoHolding[] {
    const movePorPosicao = new Map<string, PortfolioMove>();
    for (const m of moves) {
      if (m.sourcePositionId) {
        movePorPosicao.set(m.sourcePositionId, m);
      } else if (m.type === 'BUY' && m.targetTicker) {
        // B1: BUY sempre reforça o próprio ticker (sem ADD_NEW_POSITION) — encontra a posição
        // pelo ticker de destino, já que o move em si não carrega sourcePositionId nesse caso.
        const pos = state.positions.find((p) => p.ticker === m.targetTicker);
        if (pos) movePorPosicao.set(pos.id, m);
      }
    }

    const universoPorTicker = new Map(state.investmentUniverse.map((c) => [c.ticker, c]));
    const setorPorNome = new Map(state.sectors.map((s) => [s.setor, s]));

    const resultado: RecomendacaoHolding[] = state.positions.map((p: PortfolioPositionState) => {
      const move = movePorPosicao.get(p.id);
      let categoriaAcao: CategoriaAcao = 'manter';
      let sugestaoTroca: RecomendacaoHolding['sugestaoTroca'] = null;
      let valorSugerido: number | null = null;
      let quantidadeSugerida: number | null = null;
      let sugestaoRebalanceamento: RecomendacaoHolding['sugestaoRebalanceamento'] = null;
      let deltaScoreTroca: number | null = null;

      if (move) {
        switch (move.type) {
          case 'ROTATE_WITHIN_SECTOR': {
            categoriaAcao = 'troca_sugerida';
            const alvo = universoPorTicker.get(move.targetTicker!);
            sugestaoTroca = { ticker: move.targetTicker!, nome: alvo?.nome ?? move.targetTicker!, scoreFinal: alvo?.scoreFinal ?? null };
            deltaScoreTroca = alvo?.scoreFinal != null && p.scoreFinal != null ? alvo.scoreFinal - p.scoreFinal : null;
            // Particularidade real da matriz atual (isolada aqui, fora do domínio — ver comentário
            // da classe): o valor do rateio de compra continua aparecendo mesmo quando a categoria
            // virou troca_sugerida.
            const carryForward = legacyCarryForwardSuggestions.get(p.id);
            if (carryForward) {
              valorSugerido = carryForward.amount;
              quantidadeSugerida = carryForward.quantity;
              sugestaoRebalanceamento = 'comprar';
            }
            break;
          }
          case 'SELL':
            categoriaAcao = 'venda_prioritaria';
            valorSugerido = move.amount;
            quantidadeSugerida = move.quantity ?? null;
            sugestaoRebalanceamento = 'vender';
            break;
          case 'REDUCE':
            categoriaAcao = 'reducao_risco';
            valorSugerido = move.amount;
            quantidadeSugerida = move.quantity ?? null;
            sugestaoRebalanceamento = 'vender';
            break;
          case 'BUY':
            categoriaAcao = 'aportar';
            valorSugerido = move.amount;
            quantidadeSugerida = move.quantity ?? null;
            sugestaoRebalanceamento = 'comprar';
            break;
        }
      } else if (suppressedByAvailableCash.has(p.id)) {
        categoriaAcao = 'aguardar_caixa';
      }

      const setorInfo = p.setor ? setorPorNome.get(p.setor) : undefined;

      return {
        id: p.id,
        ticker: p.ticker,
        nome: universoPorTicker.get(p.ticker)?.nome ?? p.nome,
        setor: p.setor,
        scoreFinal: p.scoreFinal,
        scoreQualidade: p.scoreQualidade,
        scoreRisco: p.scoreRisco,
        scorePreco: p.scorePreco,
        percentualReal: setorInfo?.percentualAtual ?? null,
        percentualAlvo: setorInfo?.percentualAlvo ?? null,
        categoriaAcao,
        sugestaoTroca,
        motivoTroca: null,
        deltaScoreTroca,
        sugestaoRebalanceamento,
        valorSugerido,
        quantidadeSugerida,
        prioridade: PRIORIDADE_POR_CATEGORIA[categoriaAcao],
      };
    });

    const RANK_PRIORIDADE: Record<PrioridadeAcao, number> = { alta: 3, media: 2, baixa: 1 };
    resultado.sort((a, b) => {
      const rankA = a.prioridade ? RANK_PRIORIDADE[a.prioridade] : 0;
      const rankB = b.prioridade ? RANK_PRIORIDADE[b.prioridade] : 0;
      if (rankA !== rankB) return rankB - rankA;
      return Math.abs(b.valorSugerido ?? 0) - Math.abs(a.valorSugerido ?? 0);
    });

    return resultado;
  }

  /**
   * Modo B2 (multi-candidato): gera N candidatos por necessidade (setor sobrealocado → REDUCE
   * entre as posições já possuídas; subalocado/descoberto → BUY/ADD_NEW_POSITION diversificado),
   * simula cada um (`PortfolioStateTransitionService`), avalia o estado resultante
   * (`PortfolioEvaluatorService`) e escolhe pelo comparador lexicográfico
   * (`PortfolioEvaluationComparatorService`). Retorna a auditoria completa (todos os candidatos +
   * qual critério decidiu), não só o vencedor — é o que a verificação da Fase B2 usa pra
   * confirmar que a escolha é justificável, não só plausível.
   */
  async getEscolhasB2(userId: string, anoMes: string, carteira: TipoCarteira, seeds?: CandidateSeedConfig): Promise<EscolhaB2[]> {
    const state = await this.snapshotService.build(userId, anoMes, carteira);
    const moves = this.moveGenerator
      .generateB2(state, seeds)
      .moves.filter((m) => this.moveValidator.validate(state, m))
      .filter((m) => hasSufficientFunding(state, m))
      .filter((m) => this.segmentDiversificationAdmissibility.isAdmissible(state, m));

    const grupos = new Map<string, PortfolioMove[]>();
    for (const m of moves) {
      const necessidade = m.type === 'REDUCE' ? 'sobrealocado' : 'subalocado';
      const key = `${m.setor}::${necessidade}`;
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(m);
    }

    const resultado: EscolhaB2[] = [];
    for (const [key, candidatosMoves] of grupos) {
      const [setor, necessidade] = key.split('::') as [string, 'sobrealocado' | 'subalocado'];
      const candidatos: CandidatoAvaliadoB2[] = candidatosMoves.map((m) => ({
        move: m,
        evaluation: this.evaluatorService.evaluate(this.transitionService.apply(state, m).state),
      }));

      let vencedorIdx = 0;
      let decidiuPor: CriterioDecisao | null = null;
      let ignoredCoverageShiftAxes: string[] = [];

      for (let i = 1; i < candidatos.length; i++) {
        const atual = candidatos[vencedorIdx];
        const desafiante = candidatos[i];
        const cmp = this.comparatorService.compare(
          this.candidatoParaComparar(state, atual),
          this.candidatoParaComparar(state, desafiante),
        );
        decidiuPor = cmp.decidiuPor;
        ignoredCoverageShiftAxes = cmp.ignoredCoverageShiftAxes;
        if (cmp.vencedor === 'b') vencedorIdx = i;
      }

      resultado.push({
        setor,
        necessidade,
        candidatos,
        vencedor: candidatos[vencedorIdx]?.move ?? null,
        decidiuPor,
        ignoredCoverageShiftAxes,
      });
    }

    return resultado;
  }

  /**
   * Preview do motor novo (Search Engine depth=3 + Decision Trace) — só leitura, nenhuma
   * mutação. Deliberadamente PARALELO a `getRecomendacoesB1`/`getEscolhasB2`/`getRecomendacoes`
   * legado — não substitui nenhum dos dois. `saleNotional`/`purchaseNotional`/`capitalBefore`/
   * `capitalAfter` por passo não existem no `RecommendationPlanStep` do Decision Trace, então
   * reaplica `bestLine.moves` uma segunda vez via `StateTransitionService` só pra extrair esses
   * números — barato (só `bestLine.moves.length` chamadas a mais) e não toca no Decision Trace.
   */
  /** Reconstrói o snapshot do zero (fresh do banco) e roda o Search — usado tanto pelo Preview
   * quanto pela execução real (`executeNextBestAction`), que NUNCA confia num move vindo do
   * client: sempre re-deriva a Next Best Action rodando isso de novo no momento da execução. */
  private async runSearch(userId: string, anoMes: string, carteira: TipoCarteira) {
    const state = await this.snapshotService.build(userId, anoMes, carteira);
    const rootEvaluation = this.evaluatorService.evaluate(state);
    const searchConfig = { ...DEFAULT_SEARCH_CONFIG, maxDepth: 3 };
    const result = this.searchEngine.search(state, searchConfig);
    return { state, rootEvaluation, searchConfig, result };
  }

  async getPreview(userId: string, anoMes: string, carteira: TipoCarteira = 'real'): Promise<RecommendationPreviewResult> {
    const { state, rootEvaluation, searchConfig, result } = await this.runSearch(userId, anoMes, carteira);
    const trace = this.decisionTrace.build(state, rootEvaluation, result.bestLine, searchConfig);

    let current = state;
    const steps: RecommendationPreviewStep[] = result.bestLine.moves.map((move, i) => {
      const capitalBefore = current.capital;
      const { state: next, saleNotional, purchaseNotional } = this.transitionService.apply(current, move);
      const passo = trace.steps[i];
      const step: RecommendationPreviewStep = {
        sequence: i + 1,
        move,
        saleNotional,
        purchaseNotional,
        capitalBefore,
        capitalAfter: next.capital,
        evaluationBefore: passo.beforeEvaluation,
        evaluationAfter: passo.afterEvaluation,
        decidedBy: passo.decidedBy,
        candidateOutcomes: passo.candidateOutcomes,
        bandaSetor: passo.bandaSetor,
      };
      current = next;
      return step;
    });

    const policyDiagnostics: PolicyDiagnostics = {
      totalExcluded: 0,
      byReason: { OWNERSHIP_WEAK: 0, ENTRY_EXPENSIVE: 0, FALLBACK_TO_ELIGIBLE: 0 },
      perStep: trace.steps.map((passo) => ({
        sequence: passo.sequence,
        setor: passo.move.setor,
        excluded: passo.policyExclusions.map((e) => ({ ticker: e.ticker, ownership: e.assessment.ownership.status, entry: e.assessment.entry.status, eligibility: e.assessment.eligibility })),
      })),
    };
    for (const passo of trace.steps) {
      for (const exclusao of passo.policyExclusions) {
        policyDiagnostics.totalExcluded++;
        if (exclusao.assessment.eligibility === 'ELIGIBLE') policyDiagnostics.byReason.FALLBACK_TO_ELIGIBLE++;
        else if (exclusao.assessment.ownership.status === 'WEAK') policyDiagnostics.byReason.OWNERSHIP_WEAK++;
        else policyDiagnostics.byReason.ENTRY_EXPENSIVE++;
      }
    }

    // Ver plano "Next Best Action": só steps[0] é recomendação real, o resto é projeção. Sem
    // nenhum move admissível, distingue "nada foi gerado" de "Comparator escolheu ficar parado"
    // usando o que o Search já expõe (statesGenerated) — nenhuma mudança dentro do Search.
    const nextBestAction = steps[0] ?? null;
    const terminalReason = nextBestAction ? undefined : result.metadata.statesGenerated === 0 ? ('NO_ADMISSIBLE_MOVE' as const) : ('STOP_SELECTED' as const);
    const nextBestActionFingerprint = nextBestAction ? actionFingerprint(nextBestAction.move) : undefined;
    const snapshotHash = this.hasher.economicStateHash(state);

    return {
      engineVersion: RECOMMENDATION_ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      carteira,
      anoMes,
      snapshot: {
        portfolioValue: state.valorTotalCarteira,
        investedValue: state.valorTotalAcoes,
        availableCapital: availableToInvest(state.capital),
        rankingVersion: state.rankingVersion,
        snapshotHash,
      },
      initialEvaluation: rootEvaluation,
      bestPlan: {
        steps,
        nextBestAction,
        nextBestActionFingerprint,
        projectedPath: steps.slice(1),
        terminalReason,
        finalEvaluation: result.bestLine.finalEvaluation,
        turnover: result.bestLine.cumulativeTurnover,
        capitalResidual: current.capital,
      },
      policyDiagnostics,
      alternatives: result.alternatives.map((a) => ({ moves: a.moves, finalEvaluation: a.finalEvaluation, turnover: a.cumulativeTurnover })),
      searchMetadata: result.metadata,
      config: {
        maxDepth: searchConfig.maxDepth,
        beamWidth: searchConfig.beamWidth,
        maxMovesPerNode: searchConfig.maxMovesPerNode,
        rebalanceToleranceMode: state.rebalanceToleranceMode,
        balanceMaterialityThresholdPp: DEFAULT_BALANCE_MATERIALITY_THRESHOLD_PP,
        engineVersion: RECOMMENDATION_ENGINE_VERSION,
        rankingVersion: state.rankingVersion,
      },
    };
  }

  /**
   * Executa de verdade a Next Best Action — ver plano "Next Best Action / Receding Horizon".
   * NUNCA confia no move do client: reconstrói o snapshot e roda o Search de novo aqui dentro,
   * e só executa se a ação recalculada bater com a que o usuário confirmou olhando o Preview
   * (`expectedActionFingerprint`/`expectedSnapshotHash` — anti-stale). Idempotência SEPARADA do
   * anti-stale: a MESMA confirmação (mesma chave) nunca persiste 2 transações, mesmo em duplo
   * clique/retry — devolve a transação já existente em vez de executar de novo.
   */
  async executeNextBestAction(
    userId: string,
    anoMes: string,
    carteira: TipoCarteira,
    expectedActionFingerprint: string,
    expectedSnapshotHash: string,
  ): Promise<
    | { status: 'EXECUTED'; projectedMove: PortfolioMove; executedTransaction: unknown; executionDifference: { quantityDiff: number; amountDiff: number } }
    | { status: 'ALREADY_EXECUTED'; executedTransaction: unknown }
  > {
    const { state, result } = await this.runSearch(userId, anoMes, carteira);
    const nextBestAction = result.bestLine.moves[0] ?? null;

    if (!nextBestAction) {
      throw new ConflictException({ code: 'NEXT_BEST_ACTION_CHANGED', reason: 'NO_ADMISSIBLE_MOVE_NOW', currentNextBestAction: null });
    }

    const currentFingerprint = actionFingerprint(nextBestAction);
    const currentSnapshotHash = this.hasher.economicStateHash(state);

    if (currentFingerprint !== expectedActionFingerprint || currentSnapshotHash !== expectedSnapshotHash) {
      throw new ConflictException({
        code: 'NEXT_BEST_ACTION_CHANGED',
        currentNextBestAction: nextBestAction,
        currentSnapshotHash,
      });
    }

    const idempotencyKey = createHash('sha256').update(`${userId}::${currentSnapshotHash}::${currentFingerprint}`).digest('hex');

    const jaExecutada = await this.simulacaoService.buscarTransacaoPorIdempotencyKey(idempotencyKey);
    if (jaExecutada) {
      return { status: 'ALREADY_EXECUTED', executedTransaction: jaExecutada };
    }

    const { projectedMove, executedTransaction, executionDifference } = await this.simulacaoService.executarMoveDoMotor(userId, nextBestAction, anoMes, idempotencyKey);
    return { status: 'EXECUTED', projectedMove, executedTransaction, executionDifference };
  }

  private candidatoParaComparar(state: PortfolioState, candidato: CandidatoAvaliadoB2): CandidatoParaComparar {
    const ticker = candidato.move.targetTicker ?? candidato.move.sourceTicker;
    const scoreFinalResultante =
      state.investmentUniverse.find((c) => c.ticker === ticker)?.scoreFinal ?? state.positions.find((p) => p.ticker === ticker)?.scoreFinal ?? null;
    return {
      evaluation: candidato.evaluation,
      amount: candidato.move.amount,
      confidence: candidato.move.confidence,
      scoreFinalResultante,
      // Comparação de UM move isolado (sem histórico multi-move) — round-trip nunca se aplica aqui.
      roundTripDetected: detectRoundTripSameTicker([candidato.move]).length > 0,
    };
  }
}
