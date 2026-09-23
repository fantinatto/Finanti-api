import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RankingQueryService } from '../../market-data/services/ranking-query.service';
import { UpsertInvestimentoDto } from '../dto/upsert-investimento.dto';

/** Espelha PortfolioConfig.tipoRankingRecomendacao — qual ranking define "o melhor ticker do
 * grupo" e os scores usados pra decidir troca/split de aporte. Não afeta o rebalanceamento por
 * valor (sempre por setor, via AlocacaoSetor). */
type TipoRankingRecomendacao = 'setor' | 'segmento' | 'geral' | 'hibrido';
const TIPO_RANKING_PADRAO: TipoRankingRecomendacao = 'setor';

interface ScoreBasico {
  scoreFinal: number | null;
  scoreQualidade: number | null;
  scoreRisco: number | null;
  scorePreco: number | null;
}

export interface GanhoInvestimento {
  id: string;
  tipo: string;
  ticker: string | null;
  nome: string;
  precoMedio: number;
  quantidade: number;
  cotacaoAtual: number | null;
  valorInvestido: number;
  valorAtual: number | null;
  ganho: number | null;
  ganhoPercentual: number | null;
}

/**
 * Categoria única da recomendação — a UI usa isso pra escolher rótulo/cor do badge sem
 * reimplementar a matriz de decisão no front. Deriva 1:1 de statusSetor × presença de troca.
 */
export type CategoriaAcao =
  | 'aporte_direcionado' // subalocado + troca: aportar no melhor do setor em vez do atual
  | 'aportar' // subalocado, sem troca: reforçar o próprio ticker
  | 'troca_sugerida' // equilibrado + delta de score alto: pair trade
  | 'venda_prioritaria' // sobrealocado + troca: score fraco, vender e migrar
  | 'reducao_risco' // sobrealocado, sem troca: realizar lucro parcial
  | 'manter'; // nada a fazer

export interface RecomendacaoHolding {
  id: string;
  ticker: string;
  nome: string;
  setor: string | null;
  scoreFinal: number | null;
  scoreQualidade: number | null;
  scoreRisco: number | null;
  scorePreco: number | null;
  /** % que o setor dessa ação representa hoje dentro da fatia de ações da carteira. */
  percentualReal: number | null;
  /** % alvo configurada pra esse setor em Carteira (AlocacaoSetor). Null se não configurado. */
  percentualAlvo: number | null;
  categoriaAcao: CategoriaAcao;
  sugestaoTroca: { ticker: string; nome: string; scoreFinal: number | null } | null;
  /** Por que sugestaoTroca foi acionada — null quando sugestaoTroca também é null. */
  motivoTroca: string | null;
  /** scoreFinal do sugerido − scoreFinal atual — null quando sugestaoTroca também é null. */
  deltaScoreTroca: number | null;
  sugestaoRebalanceamento: 'comprar' | 'vender' | null;
  /** Valor em R$ pra aproximar o setor do alvo — quanto vender ou comprar. Null sem sugestão. */
  valorSugerido: number | null;
}

/** Fallback quando o usuário não configurou percentualEstouro em Carteira. */
const PERCENTUAL_ESTOURO_PADRAO = 5;

/**
 * Matriz de decisão (status do setor × score do ticker) — ver getRecomendacoes. Só o corte
 * de baixo importa pra decidir troca: score < SCORE_BAIXO_MATRIZ aciona; score médio (entre
 * SCORE_BAIXO_MATRIZ e o "alto" de referência, 1.5, usado só como leitura de contexto) ou
 * alto não aciona em nenhum status — o rebalanceamento de valor já resolve.
 */
const SCORE_BAIXO_MATRIZ = 1.0;
/** Setor equilibrado (dentro da banda de tolerância) mas ticker muito atrás do melhor do setor — pair trade. */
const DELTA_SCORE_TROCA = 0.6;

/**
 * Filtro de qualidade mínima (estilo Howard Marks) pra entrar no split de aporte de um setor
 * subalocado — evita direcionar dinheiro novo pra "empresa-cilada" só porque está barata.
 * Ações abaixo do corte ficam fora do rateio; se nenhuma do setor passar, o rateio cai pra
 * todas (mesmo critério de fallback já usado na escolha de venda, ver idVendaEscolhidoPorSetor).
 * Default do parâmetro opcional de getRecomendacoes — não é chumbado na lógica.
 */
const CORTE_QUALIDADE_SPLIT_APORTE_PADRAO = 0.5;

@Injectable()
export class InvestimentoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rankingQuery: RankingQueryService,
  ) {}

  async listar(userId: string) {
    return this.prisma.investimento.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async criar(userId: string, dto: UpsertInvestimentoDto) {
    return this.prisma.investimento.create({
      data: {
        userId,
        tipo: dto.tipo,
        ticker: dto.tipo === 'renda_fixa' ? null : (dto.ticker?.toUpperCase() ?? null),
        nome: dto.nome,
        precoMedio: dto.precoMedio,
        quantidade: dto.quantidade,
      },
    });
  }

  async atualizar(userId: string, id: string, dto: UpsertInvestimentoDto) {
    await this.garantirDono(userId, id);
    return this.prisma.investimento.update({
      where: { id },
      data: {
        tipo: dto.tipo,
        ticker: dto.tipo === 'renda_fixa' ? null : (dto.ticker?.toUpperCase() ?? null),
        nome: dto.nome,
        precoMedio: dto.precoMedio,
        quantidade: dto.quantidade,
      },
    });
  }

  async remover(userId: string, id: string): Promise<void> {
    await this.garantirDono(userId, id);
    await this.prisma.investimento.delete({ where: { id } });
  }

  /**
   * Ganho de cada holding no mês: (cotação do mês − preço médio) × quantidade. Renda fixa
   * não tem ticker/cotação de mercado no ranking, então fica sempre com valores null.
   */
  async calcularGanhos(userId: string, anoMes: string): Promise<GanhoInvestimento[]> {
    const investimentos = await this.listar(userId);
    const tickers = investimentos
      .map((i) => i.ticker)
      .filter((t): t is string => t !== null);

    const cotacoes = tickers.length
      ? await this.prisma.indicadorMensal.findMany({
          where: { anoMes, ticker: { in: tickers } },
          select: { ticker: true, precoFechamento: true },
        })
      : [];
    const cotacaoPorTicker = new Map(cotacoes.map((c) => [c.ticker, c.precoFechamento]));

    return investimentos.map((inv) => {
      const cotacaoAtual = inv.ticker ? (cotacaoPorTicker.get(inv.ticker) ?? null) : null;
      const valorInvestido = inv.precoMedio * inv.quantidade;
      const valorAtual = cotacaoAtual != null ? cotacaoAtual * inv.quantidade : null;
      const ganho = valorAtual != null ? valorAtual - valorInvestido : null;
      const ganhoPercentual = ganho != null && valorInvestido > 0 ? (ganho / valorInvestido) * 100 : null;

      return {
        id: inv.id,
        tipo: inv.tipo,
        ticker: inv.ticker,
        nome: inv.nome,
        precoMedio: inv.precoMedio,
        quantidade: inv.quantidade,
        cotacaoAtual,
        valorInvestido,
        valorAtual,
        ganho,
        ganhoPercentual,
      };
    });
  }

  /**
   * Recomendações por ação (só tipo 'acao' — FIIs/renda fixa não têm score, ficam de fora).
   *
   * 1. Rebalanceamento: compara quanto o setor dessa ação representa hoje na fatia de ações
   *    da carteira (percentualReal) contra a alocação-alvo configurada em Carteira
   *    (AlocacaoSetor.percentual). Se a diferença estourar percentualEstouro — a banda de
   *    tolerância, evita giro por desvios pequenos — sugere vender (setor sobrealocado) ou
   *    comprar (setor subalocado), com o valor em R$ pra chegar no alvo (base: valor atual
   *    em ações, sem recalcular a base a cada venda simulada). Quando o setor sobrealocado
   *    tem mais de uma ação na carteira, só a de menor scoreFinal recebe a sugestão de
   *    venda — vender a pior ação primeiro. Quando o setor subalocado tem mais de uma ação,
   *    o déficit em R$ é rateado entre as qualificadas (scoreQualidade ≥
   *    corteQualidadeSplitAporte) proporcionalmente ao scorePreco — não duplica o valor total
   *    em cada ação (ver valorCompraPorAcao). Dentro da banda = setor "equilibrado", sem
   *    sugestão de rebalanceamento.
   *
   * 2. Troca: cruza o status do setor (sub/sobrealocado/equilibrado) com o score do próprio
   *    ticker pra decidir SE e COM QUE ticker do mesmo setor (ainda não possuído, melhor
   *    scoreFinal) sugerir troca:
   *      - Subalocado + score baixo (<1.0): setor precisa de capital, mas não nesse ticker —
   *        sugere aportar no melhor do setor em vez de reforçar o atual.
   *      - Sobrealocado + score baixo (<1.0) NA AÇÃO ESCOLHIDA pra vender: venda prioritária,
   *        sugere migrar direto pro melhor do setor.
   *      - Equilibrado + delta de score > DELTA_SCORE_TROCA contra o melhor do setor: par de
   *        troca (pair trade) mesmo sem desalinhamento de alocação — o ticker ficou pra trás
   *        dentro do próprio setor.
   *      - Subalocado/sobrealocado + score alto ou médio (≥1.0): sem troca, só o
   *        rebalanceamento de valor acima já resolve.
   */
  async getRecomendacoes(
    userId: string,
    anoMes: string,
    corteQualidadeSplitAporte = CORTE_QUALIDADE_SPLIT_APORTE_PADRAO,
  ): Promise<RecomendacaoHolding[]> {
    const [investimentos, ganhos, config] = await Promise.all([
      this.listar(userId),
      this.calcularGanhos(userId, anoMes),
      this.prisma.portfolioConfig.findUnique({ where: { userId }, include: { alocacoesSetor: true } }),
    ]);

    const acoes = investimentos.filter((i) => i.tipo === 'acao' && i.ticker);
    if (!acoes.length) return [];

    const tickers = acoes.map((a) => a.ticker as string);
    const tipoRanking = (config?.tipoRankingRecomendacao as TipoRankingRecomendacao) ?? TIPO_RANKING_PADRAO;

    const [acaoInfos, hibridoRows] = await Promise.all([
      this.prisma.acao.findMany({
        where: { ticker: { in: tickers } },
        select: { ticker: true, nome: true, setor: true, segmento: true },
      }),
      // Só computa o blend quando de fato selecionado — é uma varredura do mercado inteiro,
      // não vale o custo se o usuário está usando setor/segmento/geral direto do banco.
      // Reaproveitado também na busca de "melhor do grupo" abaixo — evita rodar o blend 2x.
      tipoRanking === 'hibrido' ? this.rankingQuery.getRankingHibrido(anoMes) : Promise.resolve(null),
    ]);

    // Score de cada ação já possuída, na fonte definida por tipoRanking. Híbrido reaproveita
    // hibridoRows (já filtra por scoreFinal not null); os outros 3 tipos são uma query direta
    // em ScoreNormalizado — cada ticker só tem 1 linha por tipoGrupo, então não precisa de
    // nomeGrupo aqui (mesmo padrão que já existia antes desta config).
    const scorePorTicker: Map<string, ScoreBasico> =
      tipoRanking === 'hibrido'
        ? new Map((hibridoRows ?? []).filter((r) => tickers.includes(r.ticker)).map((r) => [r.ticker, r]))
        : new Map(
            (
              await this.prisma.scoreNormalizado.findMany({
                where: { tipoGrupo: tipoRanking, anoMes, ticker: { in: tickers } },
              })
            ).map((s) => [s.ticker, s]),
          );

    const acaoPorTicker = new Map(acaoInfos.map((a) => [a.ticker, a]));
    const ganhoPorId = new Map(ganhos.map((g) => [g.id, g]));

    const valorTotalAcoes = acoes.reduce((acc, a) => acc + (ganhoPorId.get(a.id)?.valorAtual ?? 0), 0);

    const valorPorSetor = new Map<string, number>();
    for (const a of acoes) {
      const setor = acaoPorTicker.get(a.ticker as string)?.setor ?? null;
      if (!setor) continue;
      valorPorSetor.set(setor, (valorPorSetor.get(setor) ?? 0) + (ganhoPorId.get(a.id)?.valorAtual ?? 0));
    }

    const alocacoesAlvo = new Map((config?.alocacoesSetor ?? []).map((a) => [a.setor, a.percentual]));
    const percentualEstouro = config?.percentualEstouro ?? PERCENTUAL_ESTOURO_PADRAO;
    const tickersJaPossuidos = new Set(tickers);

    // Setores sobrealocados com mais de uma ação: escolhe a de menor scoreFinal pra vender.
    // Setores subalocados: guarda scoreQualidade/scorePreco pra ratear o aporte (ver valorCompraPorAcao).
    const acoesPorSetor = new Map<
      string,
      { id: string; scoreFinal: number | null; scoreQualidade: number | null; scorePreco: number | null }[]
    >();
    for (const a of acoes) {
      const setor = acaoPorTicker.get(a.ticker as string)?.setor ?? null;
      if (!setor) continue;
      const s = scorePorTicker.get(a.ticker as string);
      if (!acoesPorSetor.has(setor)) acoesPorSetor.set(setor, []);
      acoesPorSetor
        .get(setor)!
        .push({ id: a.id, scoreFinal: s?.scoreFinal ?? null, scoreQualidade: s?.scoreQualidade ?? null, scorePreco: s?.scorePreco ?? null });
    }

    const idVendaEscolhidoPorSetor = new Map<string, string>();
    for (const [setor, lista] of acoesPorSetor) {
      const percentualReal = valorTotalAcoes > 0 ? ((valorPorSetor.get(setor) ?? 0) / valorTotalAcoes) * 100 : null;
      const percentualAlvo = alocacoesAlvo.get(setor) ?? null;
      if (percentualReal == null || percentualAlvo == null) continue;
      if (percentualReal - percentualAlvo <= percentualEstouro) continue;

      const comScore = lista.filter((x) => x.scoreFinal != null).sort((x, y) => x.scoreFinal! - y.scoreFinal!);
      if (comScore.length) idVendaEscolhidoPorSetor.set(setor, comScore[0].id);
      // Se nenhuma ação do setor tem score, não dá pra escolher — sugestão cai pra todas (fallback abaixo).
    }

    /**
     * Setores subalocados: rateia o déficit em R$ do setor entre as ações qualificadas
     * (scoreQualidade >= corteQualidadeSplitAporte) proporcionalmente ao scorePreco — quanto
     * maior o desconto, maior a fatia. Sem isso, cada ação do setor recebia o valor total do
     * déficit duplicado (bug corrigido aqui). Se nenhuma ação do setor passar no corte de
     * qualidade, ou nenhuma tiver scorePreco, o rateio cai pra todas em partes iguais — mesmo
     * critério de fallback usado na escolha de venda acima.
     */
    const valorCompraPorAcao = new Map<string, number>();
    for (const [setor, lista] of acoesPorSetor) {
      if (valorTotalAcoes <= 0) continue;
      const percentualAlvo = alocacoesAlvo.get(setor) ?? null;
      if (percentualAlvo == null) continue;

      const valorAtualSetor = valorPorSetor.get(setor) ?? 0;
      const percentualReal = (valorAtualSetor / valorTotalAcoes) * 100;
      if (percentualAlvo - percentualReal <= percentualEstouro) continue; // não subalocado

      const valorAlvoSetor = (percentualAlvo / 100) * valorTotalAcoes;
      const deficitSetor = valorAlvoSetor - valorAtualSetor;

      const qualificadas = lista.filter(
        (x) => (x.scoreQualidade ?? 0) >= corteQualidadeSplitAporte && x.scorePreco != null,
      );
      const base = qualificadas.length ? qualificadas : lista;
      const somaScorePreco = base.reduce((acc, x) => acc + (x.scorePreco ?? 0), 0);

      for (const x of base) {
        const proporcao = somaScorePreco > 0 ? (x.scorePreco ?? 0) / somaScorePreco : 1 / base.length;
        valorCompraPorAcao.set(x.id, deficitSetor * proporcao);
      }
    }

    const resultado: RecomendacaoHolding[] = [];

    for (const a of acoes) {
      const ticker = a.ticker as string;
      const info = acaoPorTicker.get(ticker);
      const score = scorePorTicker.get(ticker);
      const setor = info?.setor ?? null;

      const percentualReal =
        setor && valorTotalAcoes > 0 ? ((valorPorSetor.get(setor) ?? 0) / valorTotalAcoes) * 100 : null;
      const percentualAlvo = setor ? (alocacoesAlvo.get(setor) ?? null) : null;

      let statusSetor: 'subalocado' | 'sobrealocado' | 'equilibrado' | null = null;
      let sugestaoRebalanceamento: 'comprar' | 'vender' | null = null;
      let valorSugerido: number | null = null;
      let escolhidaParaVender = false;

      if (percentualReal != null && percentualAlvo != null && setor) {
        const diff = percentualReal - percentualAlvo;
        const valorAlvoSetor = (percentualAlvo / 100) * valorTotalAcoes;
        const valorAtualSetor = valorPorSetor.get(setor) ?? 0;

        if (diff > percentualEstouro) {
          statusSetor = 'sobrealocado';
          const escolhidoId = idVendaEscolhidoPorSetor.get(setor);
          escolhidaParaVender = !escolhidoId || escolhidoId === a.id;
          if (escolhidaParaVender) {
            sugestaoRebalanceamento = 'vender';
            valorSugerido = valorAtualSetor - valorAlvoSetor;
          }
        } else if (diff < -percentualEstouro) {
          statusSetor = 'subalocado';
          const valorSplit = valorCompraPorAcao.get(a.id);
          if (valorSplit != null) {
            sugestaoRebalanceamento = 'comprar';
            valorSugerido = valorSplit;
          }
        } else {
          statusSetor = 'equilibrado';
        }
      }

      const scoreFinal = score?.scoreFinal ?? null;
      const segmento = info?.segmento ?? null;

      // Melhor ticker ainda não possuído dentro do grupo definido por tipoRanking — buscado
      // sempre que dá pra comparar (score do próprio ticker conhecido), porque tanto a matriz
      // quanto o pair trade "equilibrado" precisam do delta de score pra decidir se troca vale
      // a pena. Ver buscarMelhorDoGrupo pra semântica de cada tipoRanking.
      const melhorDoGrupo =
        scoreFinal != null
          ? await this.buscarMelhorDoGrupo(tipoRanking, { setor, segmento }, anoMes, tickersJaPossuidos, hibridoRows)
          : null;

      let categoriaAcao: CategoriaAcao = 'manter';
      let sugestaoTroca: RecomendacaoHolding['sugestaoTroca'] = null;
      let motivoTroca: string | null = null;
      let deltaScoreTroca: number | null = null;

      if (melhorDoGrupo && scoreFinal != null) {
        const scoreBaixo = scoreFinal < SCORE_BAIXO_MATRIZ;
        const deltaScore = melhorDoGrupo.scoreFinal != null ? melhorDoGrupo.scoreFinal - scoreFinal : null;

        if (statusSetor === 'subalocado' && scoreBaixo) {
          categoriaAcao = 'aporte_direcionado';
          sugestaoTroca = melhorDoGrupo;
          motivoTroca = 'Setor precisa de capital, mas considere aportar nesse ticker em vez do atual';
          deltaScoreTroca = deltaScore;
        } else if (statusSetor === 'sobrealocado' && scoreBaixo && escolhidaParaVender) {
          categoriaAcao = 'venda_prioritaria';
          sugestaoTroca = melhorDoGrupo;
          motivoTroca = 'Ativo fraco em setor sobrealocado — venda prioritária, migre pra esse ticker';
          deltaScoreTroca = deltaScore;
        } else if (statusSetor === 'equilibrado' && deltaScore != null && deltaScore > DELTA_SCORE_TROCA) {
          categoriaAcao = 'troca_sugerida';
          sugestaoTroca = melhorDoGrupo;
          motivoTroca = 'Score bem abaixo do melhor do setor — considere migrar mesmo com a alocação equilibrada';
          deltaScoreTroca = deltaScore;
        }
      }

      // Sem troca acionada — categoria cai pro rebalanceamento puro (ou "manter", já default).
      if (categoriaAcao === 'manter') {
        // sugestaoRebalanceamento pode ficar null mesmo com statusSetor 'subalocado' quando a
        // ação foi excluída do split por reprovar no filtro de qualidade (corteQualidadeSplitAporte).
        if (statusSetor === 'subalocado' && sugestaoRebalanceamento === 'comprar') categoriaAcao = 'aportar';
        else if (statusSetor === 'sobrealocado' && escolhidaParaVender) categoriaAcao = 'reducao_risco';
      }

      resultado.push({
        id: a.id,
        ticker,
        nome: info?.nome ?? a.nome,
        setor,
        scoreFinal,
        scoreQualidade: score?.scoreQualidade ?? null,
        scoreRisco: score?.scoreRisco ?? null,
        scorePreco: score?.scorePreco ?? null,
        percentualReal,
        percentualAlvo,
        categoriaAcao,
        sugestaoTroca,
        motivoTroca,
        deltaScoreTroca,
        sugestaoRebalanceamento,
        valorSugerido,
      });
    }

    return resultado;
  }

  /**
   * "Melhor ticker do grupo" ainda não possuído, na fonte definida por tipoRanking:
   * - 'setor'/'segmento': restrito à própria classificação da ação (mesmo comportamento de
   *   antes desta config existir).
   * - 'geral': sem sub-classificação nenhuma — pode sugerir ticker de qualquer setor/segmento,
   *   é o melhor score do mercado inteiro. Muda o caráter da sugestão (deixa de ser "melhor
   *   dentro do seu próprio nicho"), documentado aqui de propósito.
   * - 'hibrido': filtra hibridoRows (já calculado 1x em getRecomendacoes) pelo setor da ação —
   *   mantém a sugestão dentro do mesmo setor mesmo usando o score blendado, já que o híbrido
   *   não tem nomeGrupo próprio pra restringir a busca no banco.
   */
  private async buscarMelhorDoGrupo(
    tipoRanking: TipoRankingRecomendacao,
    acao: { setor: string | null; segmento: string | null },
    anoMes: string,
    tickersJaPossuidos: Set<string>,
    hibridoRows: Awaited<ReturnType<RankingQueryService['getRankingHibrido']>> | null,
  ): Promise<{ ticker: string; nome: string; scoreFinal: number | null } | null> {
    if (tipoRanking === 'hibrido') {
      const candidatos = (hibridoRows ?? [])
        .filter((r) => r.setor === acao.setor && !tickersJaPossuidos.has(r.ticker) && r.scoreFinal != null)
        .sort((a, b) => (b.scoreFinal ?? 0) - (a.scoreFinal ?? 0));
      const melhor = candidatos[0];
      return melhor ? { ticker: melhor.ticker, nome: melhor.nome, scoreFinal: melhor.scoreFinal } : null;
    }

    let nomeGrupo: string | null = null;
    if (tipoRanking === 'setor') nomeGrupo = acao.setor;
    else if (tipoRanking === 'segmento') nomeGrupo = acao.segmento;
    if (tipoRanking !== 'geral' && !nomeGrupo) return null; // sem classificação, não dá pra buscar

    const melhor = await this.prisma.scoreNormalizado.findFirst({
      where: {
        tipoGrupo: tipoRanking,
        ...(nomeGrupo ? { nomeGrupo } : {}),
        anoMes,
        scoreFinal: { not: null },
        ticker: { notIn: Array.from(tickersJaPossuidos) },
      },
      orderBy: { scoreFinal: 'desc' },
      include: { acao: { select: { nome: true } } },
    });
    return melhor ? { ticker: melhor.ticker, nome: melhor.acao.nome, scoreFinal: melhor.scoreFinal } : null;
  }

  private async garantirDono(userId: string, id: string): Promise<void> {
    const inv = await this.prisma.investimento.findUnique({ where: { id }, select: { userId: true } });
    if (!inv || inv.userId !== userId) {
      throw new NotFoundException('Investimento não encontrado.');
    }
  }
}
