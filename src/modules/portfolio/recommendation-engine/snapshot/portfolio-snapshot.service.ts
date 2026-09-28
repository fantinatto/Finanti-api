import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RankingQueryService } from '../../../market-data/services/ranking-query.service';
import { InvestimentoService, TipoCarteira, TipoRankingRecomendacao } from '../../services/investimento.service';
import {
  availableToInvest,
  computeSectorAllocation,
  computeSegmentConcentration,
  InvestmentCandidateMetadata,
  OrigemScore,
  PortfolioPositionState,
  PortfolioState,
} from '../domain/portfolio-state';
import { computeSectorMarketStates } from '../domain/sector-market-state';
import { DEFAULT_DYNAMIC_REBALANCE_CONFIG, DynamicAllocationBandResult, RebalanceToleranceMode } from '../domain/dynamic-allocation-band';
import { DynamicAllocationBandService } from '../allocation-band/dynamic-allocation-band.service';

const PERCENTUAL_ESTOURO_PADRAO = 5;
const TIPO_RANKING_PADRAO: TipoRankingRecomendacao = 'setor';

interface ScoreUniverseEntry {
  scoreQualidade: number | null;
  qualidadeDelta: number | null;
  scoreRisco: number | null;
  riscoDelta: number | null;
  riscoComposto: number | null;
  scorePreco: number | null;
  precoDelta: number | null;
  scoreFinal: number | null;
  scoreFinalDelta: number | null;
  origemScore: OrigemScore | null;
}

/**
 * Constrói o `PortfolioState` — uma vez, uma query por fonte de dado — que alimenta
 * `PortfolioEvaluatorService` e (Fase B em diante) o `PortfolioMoveGeneratorService`. Depende de
 * `InvestimentoService` só pelos métodos públicos e sem efeitos colaterais (`listar`,
 * `calcularGanhos`, `buscarScorePorTicker`) — dependência unidirecional, sem risco de ciclo:
 * `InvestimentoService` não injeta nada deste módulo na Fase A/B1 (ver plano, wrappers vêm depois).
 */
@Injectable()
export class PortfolioSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rankingQuery: RankingQueryService,
    private readonly investimentos: InvestimentoService,
    private readonly dynamicAllocationBandService: DynamicAllocationBandService,
  ) {}

  async build(userId: string, anoMes: string, carteira: TipoCarteira): Promise<PortfolioState> {
    const [investimentosTodos, ganhos, config] = await Promise.all([
      this.investimentos.listar(userId, carteira),
      this.investimentos.calcularGanhos(userId, anoMes, carteira),
      this.prisma.portfolioConfig.findUnique({ where: { userId }, include: { alocacoesSetor: true } }),
    ]);

    const acoesInv = investimentosTodos.filter((i) => i.tipo === 'acao' && i.ticker);
    const tickers = acoesInv.map((a) => a.ticker as string);
    const tipoRanking = (config?.tipoRankingRecomendacao as TipoRankingRecomendacao) ?? TIPO_RANKING_PADRAO;
    const percentualEstouro = config?.percentualEstouro ?? PERCENTUAL_ESTOURO_PADRAO;
    const permiteFracionario = config?.permiteFracionario ?? true;
    const alocacoesAlvo = new Map((config?.alocacoesSetor ?? []).map((a) => [a.setor, a.percentual]));

    const hibridoRows = tipoRanking === 'hibrido' ? await this.rankingQuery.getRankingHibrido(anoMes) : null;

    const [acaoInfos, scorePorTicker] = await Promise.all([
      tickers.length
        ? this.prisma.acao.findMany({ where: { ticker: { in: tickers } }, select: { ticker: true, nome: true, setor: true, segmento: true } })
        : Promise.resolve([] as { ticker: string; nome: string; setor: string | null; segmento: string | null }[]),
      tickers.length ? this.investimentos.buscarScorePorTicker(tipoRanking, anoMes, tickers, hibridoRows) : Promise.resolve(new Map()),
    ]);
    const acaoInfoPorTicker = new Map(acaoInfos.map((a) => [a.ticker, a]));
    const ganhoPorId = new Map(ganhos.map((g) => [g.id, g]));

    const positions: PortfolioPositionState[] = acoesInv.map((a) => {
      const ticker = a.ticker as string;
      const info = acaoInfoPorTicker.get(ticker);
      const score = scorePorTicker.get(ticker);
      const ganho = ganhoPorId.get(a.id);
      return {
        id: a.id,
        ticker,
        nome: info?.nome ?? a.nome,
        tipo: a.tipo as 'acao',
        quantidade: a.quantidade,
        precoMedio: a.precoMedio,
        cotacaoAtual: ganho?.cotacaoAtual ?? null,
        // `?? 0`, NUNCA fallback pra valorInvestido — precisa bater exatamente com o peso que
        // construirContextoRebalanceamento/getSaudeCarteira já usam hoje pra excluir posições sem
        // cotação da média ponderada (peso 0 tem o mesmo efeito do `continue` que esses métodos
        // fazem). Um fallback pra custo aqui produziria uma Saúde "displayed" diferente da atual,
        // violando o critério de aceite da Fase A (idêntico, sem exceção).
        valorAtual: ganho?.valorAtual ?? 0,
        setor: info?.setor ?? null,
        segmento: info?.segmento ?? null,
        scoreQualidade: score?.scoreQualidade ?? null,
        qualidadeDelta: score?.qualidadeDelta ?? null,
        scoreRisco: score?.scoreRisco ?? null,
        riscoDelta: score?.riscoDelta ?? null,
        riscoComposto: score?.riscoComposto ?? null,
        scorePreco: score?.scorePreco ?? null,
        precoDelta: score?.precoDelta ?? null,
        scoreFinal: score?.scoreFinal ?? null,
        scoreFinalDelta: score?.scoreFinalDelta ?? null,
        origemScore: score?.origemScore ?? null,
      };
    });

    const valorTotalAcoes = positions.reduce((acc, p) => acc + p.valorAtual, 0);
    // Mesma semântica de SaudeCarteira.valorTotalCarteira hoje: TODA a carteira (não só ações),
    // com fallback pro custo quando falta cotação — ver comentário do campo em PortfolioState.
    const valorTotalCarteira = ganhos.reduce((acc, g) => acc + (g.valorAtual ?? g.valorInvestido), 0);

    const valorPorSetor = new Map<string, number>();
    for (const p of positions) {
      if (!p.setor) continue;
      valorPorSetor.set(p.setor, (valorPorSetor.get(p.setor) ?? 0) + p.valorAtual);
    }

    const existingCash =
      carteira === 'simulacao' ? ((await this.prisma.simulacaoConfig.findUnique({ where: { userId } }))?.caixaDisponivel ?? 0) : 0;
    const capital = { existingCash, externalContributionBudget: 0, proceedsGeneratedByPlan: 0 };
    // Capturada UMA VEZ aqui, no estado inicial — StateTransition.apply nunca recalcula isso, só
    // copia adiante (ver comentário do campo em domain/portfolio-state.ts).
    const searchAllocationBase = valorTotalAcoes + availableToInvest(capital);

    // Denominador VIVO (legado/B1, bit-a-bit igual à matriz atual) vs ESTÁVEL (searchAllocationBase,
    // usado por generateB2/busca em diante — ver "achado" do Estouro Dinâmico no plano).
    const sectors = computeSectorAllocation(valorPorSetor, alocacoesAlvo, valorTotalAcoes, percentualEstouro);
    const stableSectors = computeSectorAllocation(valorPorSetor, alocacoesAlvo, searchAllocationBase, percentualEstouro);

    const investmentUniverse = await this.buildInvestmentUniverse(anoMes, tipoRanking, hibridoRows);
    const segmentConcentration = computeSegmentConcentration(positions, investmentUniverse, sectors);
    const sectorMarketStates = computeSectorMarketStates(investmentUniverse);

    const rebalanceToleranceMode: RebalanceToleranceMode = (config?.rebalanceToleranceMode as RebalanceToleranceMode) ?? 'FIXED';
    const dynamicRebalanceConfig = {
      maxAdjustment: config?.dynamicMaxAdjustment ?? DEFAULT_DYNAMIC_REBALANCE_CONFIG.maxAdjustment,
      guardrailEnabled: config?.dynamicGuardrailEnabled ?? DEFAULT_DYNAMIC_REBALANCE_CONFIG.guardrailEnabled,
    };

    let dynamicAllocationBands: DynamicAllocationBandResult[] = [];
    let dynamicSectors = stableSectors;
    if (rebalanceToleranceMode === 'DYNAMIC_PRICE') {
      const marketStatePorSetor = new Map(sectorMarketStates.map((s) => [s.setor, s]));
      dynamicAllocationBands = stableSectors.map((s) =>
        this.dynamicAllocationBandService.calculate({
          setor: s.setor,
          target: s.percentualAlvo,
          percentualAtual: s.percentualAtual,
          baseTolerance: percentualEstouro,
          marketState: marketStatePorSetor.get(s.setor),
          universo: sectorMarketStates,
          maxAdjustment: dynamicRebalanceConfig.maxAdjustment,
          guardrailEnabled: dynamicRebalanceConfig.guardrailEnabled,
        }),
      );
      const bandaPorSetor = new Map(dynamicAllocationBands.map((b) => [b.setor, b]));
      dynamicSectors = stableSectors.map((s) => ({ ...s, status: bandaPorSetor.get(s.setor)?.status ?? s.status }));
    }

    return {
      userId,
      anoMes,
      carteira,
      positions,
      capital,
      valorTotalAcoes,
      valorTotalCarteira,
      searchAllocationBase,
      sectors,
      stableSectors,
      dynamicSectors,
      sectorMarketStates,
      dynamicAllocationBands,
      rebalanceToleranceMode,
      dynamicRebalanceConfig,
      segmentConcentration,
      percentualEstouro,
      permiteFracionario,
      tipoRanking,
      investmentUniverse,
      rankingVersion: `${anoMes}:${tipoRanking}:${carteira}`,
    };
  }

  /**
   * Todo ticker do universo com score calculável nesse anoMes/tipoRanking — não só os possuídos.
   * Uma query (mais nome/setor/segmento e cotação, sempre buscados à parte pra não duplicar
   * lógica de include por fonte). Construído aqui pra que o MoveGenerator (Fase B) nunca precise
   * voltar ao banco por candidato — nem em profundidade >1 (Fase C), quando isso aconteceria por
   * nó da busca.
   */
  private async buildInvestmentUniverse(
    anoMes: string,
    tipoRanking: TipoRankingRecomendacao,
    hibridoRows: Awaited<ReturnType<RankingQueryService['getRankingHibrido']>> | null,
  ): Promise<InvestmentCandidateMetadata[]> {
    const scorePorTicker = new Map<string, ScoreUniverseEntry>();

    if (tipoRanking === 'hibrido') {
      for (const r of hibridoRows ?? []) {
        if (r.scoreFinal == null) continue;
        scorePorTicker.set(r.ticker, {
          scoreQualidade: r.scoreQualidade,
          qualidadeDelta: r.qualidadeDelta,
          scoreRisco: r.scoreRisco,
          riscoDelta: r.riscoDelta,
          riscoComposto: r.riscoComposto,
          scorePreco: r.scorePreco,
          precoDelta: r.precoDelta,
          scoreFinal: r.scoreFinal,
          scoreFinalDelta: r.scoreFinalDelta,
          origemScore: null, // híbrido não carrega o conceito de fallback de segmento
        });
      }
    } else if (tipoRanking === 'segmento') {
      const fallback = await this.rankingQuery.getScoresSegmentoComFallback(anoMes);
      for (const [ticker, s] of fallback) {
        scorePorTicker.set(ticker, {
          scoreQualidade: s.scoreQualidade,
          qualidadeDelta: s.qualidadeDelta,
          scoreRisco: s.scoreRisco,
          riscoDelta: s.riscoDelta,
          riscoComposto: s.riscoComposto,
          scorePreco: s.scorePreco,
          precoDelta: s.precoDelta,
          scoreFinal: s.scoreFinal,
          scoreFinalDelta: s.scoreFinalDelta,
          origemScore: s.origemScore,
        });
      }
    } else {
      // 'setor' | 'geral' — 1 linha por ticker independente do nomeGrupo específico (cada ticker
      // só tem 1 score nesse tier: o do seu próprio setor, ou o geral único).
      const rows = await this.prisma.scoreNormalizado.findMany({
        where: { tipoGrupo: tipoRanking, anoMes, scoreFinal: { not: null } },
        orderBy: { ticker: 'asc' },
      });
      for (const r of rows) {
        scorePorTicker.set(r.ticker, {
          scoreQualidade: r.scoreQualidade,
          qualidadeDelta: r.qualidadeDelta,
          scoreRisco: r.scoreRisco,
          riscoDelta: r.riscoDelta,
          riscoComposto: r.riscoComposto,
          scorePreco: r.scorePreco,
          precoDelta: r.precoDelta,
          scoreFinal: r.scoreFinal,
          scoreFinalDelta: r.scoreFinalDelta,
          origemScore: null,
        });
      }
    }

    const universeTickers = [...scorePorTicker.keys()];
    if (!universeTickers.length) return [];

    const [acaoInfos, cotacoes] = await Promise.all([
      this.prisma.acao.findMany({ where: { ticker: { in: universeTickers } }, select: { ticker: true, nome: true, setor: true, segmento: true } }),
      this.prisma.indicadorMensal.findMany({ where: { anoMes, ticker: { in: universeTickers } }, select: { ticker: true, precoFechamento: true } }),
    ]);
    const acaoInfoPorTicker = new Map(acaoInfos.map((a) => [a.ticker, a]));
    const cotacaoPorTicker = new Map(cotacoes.map((c) => [c.ticker, c.precoFechamento]));

    return universeTickers.map((ticker) => {
      const info = acaoInfoPorTicker.get(ticker);
      const score = scorePorTicker.get(ticker)!;
      return {
        ticker,
        nome: info?.nome ?? ticker,
        setor: info?.setor ?? null,
        segmento: info?.segmento ?? null,
        cotacao: cotacaoPorTicker.get(ticker) ?? null,
        ...score,
      };
    });
  }
}
