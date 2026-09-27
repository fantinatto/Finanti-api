import { Injectable } from '@nestjs/common';
import {
  CategoriaAcao,
  PRIORIDADE_POR_CATEGORIA,
  PrioridadeAcao,
  RecomendacaoHolding,
  TipoCarteira,
} from '../services/investimento.service';
import { PortfolioSnapshotService } from './snapshot/portfolio-snapshot.service';
import { PortfolioEvaluatorService } from './evaluation/portfolio-evaluator.service';
import { CandidatoParaComparar, CriterioDecisao, PortfolioEvaluationComparatorService } from './evaluation/portfolio-evaluation-comparator.service';
import { CandidateSeedConfig, PortfolioMoveGeneratorService } from './moves/portfolio-move-generator.service';
import { PortfolioMoveValidatorService } from './moves/portfolio-move-validator.service';
import { PortfolioStateTransitionService } from './simulation/portfolio-state-transition.service';
import { PortfolioMove } from './domain/portfolio-move';
import { PortfolioPositionState, PortfolioState } from './domain/portfolio-state';

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
  ) {}

  async getRecomendacoesB1(userId: string, anoMes: string, carteira: TipoCarteira): Promise<RecomendacaoHolding[]> {
    const state = await this.snapshotService.build(userId, anoMes, carteira);
    const { moves, suppressedByAvailableCash } = this.moveGenerator.generateB1(state);
    const movesValidos = moves.filter((m) => this.moveValidator.validate(state, m));
    return this.converterParaRecomendacoes(state, movesValidos, suppressedByAvailableCash);
  }

  private converterParaRecomendacoes(
    state: PortfolioState,
    moves: PortfolioMove[],
    suppressedByAvailableCash: Set<string>,
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
            // Particularidade real da matriz atual (ver domain/portfolio-move.ts): o valor do
            // rateio de compra continua aparecendo mesmo quando a categoria virou troca_sugerida.
            if (move.carryForwardSuggestion) {
              valorSugerido = move.carryForwardSuggestion.amount;
              quantidadeSugerida = move.carryForwardSuggestion.quantity;
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
    const before = this.evaluatorService.evaluate(state);
    const moves = this.moveGenerator.generateB2(state, seeds).filter((m) => this.moveValidator.validate(state, m));

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
        evaluation: this.evaluatorService.evaluate(this.transitionService.apply(state, m)),
      }));

      let vencedorIdx = 0;
      let decidiuPor: CriterioDecisao | null = null;
      let ignoredCoverageShiftAxes: string[] = [];

      for (let i = 1; i < candidatos.length; i++) {
        const atual = candidatos[vencedorIdx];
        const desafiante = candidatos[i];
        const cmp = this.comparatorService.compare(
          before,
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

  private candidatoParaComparar(state: PortfolioState, candidato: CandidatoAvaliadoB2): CandidatoParaComparar {
    const ticker = candidato.move.targetTicker ?? candidato.move.sourceTicker;
    const scoreFinalResultante =
      state.investmentUniverse.find((c) => c.ticker === ticker)?.scoreFinal ?? state.positions.find((p) => p.ticker === ticker)?.scoreFinal ?? null;
    return {
      evaluation: candidato.evaluation,
      amount: candidato.move.amount,
      confidence: candidato.move.confidence,
      scoreFinalResultante,
    };
  }
}
