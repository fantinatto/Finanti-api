import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RankingQueryService } from '../../market-data/services/ranking-query.service';
import { UpsertInvestimentoDto } from '../dto/upsert-investimento.dto';
import { arredondarParaLote } from './lote';

/** "real" | "simulacao" — mesma tabela Investimento, carteiras isoladas por usuário. Usado em
 * todo método público deste service pra filtrar/gravar na carteira certa. */
export type TipoCarteira = 'real' | 'simulacao';
const CARTEIRA_PADRAO: TipoCarteira = 'real';

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

/**
 * Prioridade de execução — deriva 1:1 de categoriaAcao (função pura, ver PRIORIDADE_POR_CATEGORIA),
 * sem nenhum limiar novo: reaproveita a semântica que a própria matriz de decisão já carrega.
 * null só em 'manter' (nada a priorizar). Usado pra ordenar a lista de recomendações — ver o
 * final de getRecomendacoes — e pra badge de UX no front (Alta/Média/Baixa).
 *
 * - alta: venda_prioritaria (pior combinação: score fraco + setor sobrealocado) e troca_sugerida
 *   (só existe quando deltaScoreTroca > DELTA_SCORE_TROCA — oportunidade grande de qualidade) —
 *   as duas já são executáveis hoje (têm venda real associada).
 * - media: reducao_risco (executável, mas o ticker em si não é ruim — trim tático de tamanho de
 *   posição, não de qualidade) e aporte_direcionado (não executável hoje, mas indica pra onde
 *   direcionar o PRÓXIMO aporte com um motivo concreto de score).
 * - baixa: aportar (subalocado sem nenhum sinal de qualidade além de "o setor precisa de capital").
 */
export type PrioridadeAcao = 'alta' | 'media' | 'baixa';

const PRIORIDADE_POR_CATEGORIA: Record<CategoriaAcao, PrioridadeAcao | null> = {
  venda_prioritaria: 'alta',
  troca_sugerida: 'alta',
  reducao_risco: 'media',
  aporte_direcionado: 'media',
  aportar: 'baixa',
  manter: null,
};

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
  /** Prioridade de execução — ver PrioridadeAcao. Null só em categoriaAcao='manter'. */
  prioridade: PrioridadeAcao | null;
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

interface AcaoContextoSetor {
  id: string;
  ticker: string;
  scoreFinal: number | null;
  scoreQualidade: number | null;
  scorePreco: number | null;
}

/**
 * Estado intermediário compartilhado por getRecomendacoes e pelo fluxo de aporte semanal da
 * simulação (SimulacaoService.aplicarAporteSemanal) — os dois precisam da mesma agregação de
 * "quanto cada setor representa hoje vs. o alvo configurado" pra decidir onde direcionar
 * dinheiro novo. Ver construirContextoRebalanceamento.
 */
export interface ContextoRebalanceamento {
  acoes: { id: string; ticker: string }[];
  valorTotalAcoes: number;
  valorPorSetor: Map<string, number>;
  alocacoesAlvo: Map<string, number>;
  percentualEstouro: number;
  acoesPorSetor: Map<string, AcaoContextoSetor[]>;
}

@Injectable()
export class InvestimentoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rankingQuery: RankingQueryService,
  ) {}

  async listar(userId: string, carteira: TipoCarteira = CARTEIRA_PADRAO) {
    return this.prisma.investimento.findMany({ where: { userId, carteira }, orderBy: { createdAt: 'asc' } });
  }

  async criar(userId: string, dto: UpsertInvestimentoDto, carteira: TipoCarteira = CARTEIRA_PADRAO) {
    return this.prisma.investimento.create({
      data: {
        userId,
        carteira,
        tipo: dto.tipo,
        ticker: dto.tipo === 'renda_fixa' ? null : (dto.ticker?.toUpperCase() ?? null),
        nome: dto.nome,
        precoMedio: dto.precoMedio,
        quantidade: dto.quantidade,
      },
    });
  }

  async atualizar(userId: string, id: string, dto: UpsertInvestimentoDto, carteira: TipoCarteira = CARTEIRA_PADRAO) {
    await this.garantirDono(userId, id, carteira);
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

  async remover(userId: string, id: string, carteira: TipoCarteira = CARTEIRA_PADRAO): Promise<void> {
    await this.garantirDono(userId, id, carteira);
    await this.prisma.investimento.delete({ where: { id } });
  }

  /**
   * Ganho de cada holding no mês: (cotação do mês − preço médio) × quantidade. Renda fixa
   * não tem ticker/cotação de mercado no ranking, então fica sempre com valores null.
   */
  async calcularGanhos(userId: string, anoMes: string, carteira: TipoCarteira = CARTEIRA_PADRAO): Promise<GanhoInvestimento[]> {
    const investimentos = await this.listar(userId, carteira);
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
   * Agrega tudo que getRecomendacoes e o aporte semanal da simulação precisam sobre "quanto
   * cada setor representa hoje vs. o alvo configurado em Carteira": valor atual por setor,
   * alocação-alvo, banda de tolerância, e as ações de cada setor com os campos de score usados
   * pro rateio proporcional (ver calcularValorCompraPorSetor). Retorna null quando não há
   * nenhuma ação (tipo='acao') na carteira — nada pra rebalancear.
   */
  async construirContextoRebalanceamento(
    userId: string,
    anoMes: string,
    carteira: TipoCarteira,
  ): Promise<ContextoRebalanceamento | null> {
    const [investimentos, ganhos, config] = await Promise.all([
      this.listar(userId, carteira),
      this.calcularGanhos(userId, anoMes, carteira),
      this.prisma.portfolioConfig.findUnique({ where: { userId }, include: { alocacoesSetor: true } }),
    ]);

    const acoesInv = investimentos.filter((i) => i.tipo === 'acao' && i.ticker);
    if (!acoesInv.length) return null;

    const tickers = acoesInv.map((a) => a.ticker as string);
    const tipoRanking = (config?.tipoRankingRecomendacao as TipoRankingRecomendacao) ?? TIPO_RANKING_PADRAO;

    const [acaoInfos, hibridoRows] = await Promise.all([
      this.prisma.acao.findMany({
        where: { ticker: { in: tickers } },
        select: { ticker: true, setor: true },
      }),
      tipoRanking === 'hibrido' ? this.rankingQuery.getRankingHibrido(anoMes) : Promise.resolve(null),
    ]);

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

    const setorPorTicker = new Map(acaoInfos.map((a) => [a.ticker, a.setor]));
    const ganhoPorId = new Map(ganhos.map((g) => [g.id, g]));
    const valorTotalAcoes = acoesInv.reduce((acc, a) => acc + (ganhoPorId.get(a.id)?.valorAtual ?? 0), 0);

    const valorPorSetor = new Map<string, number>();
    for (const a of acoesInv) {
      const setor = setorPorTicker.get(a.ticker as string) ?? null;
      if (!setor) continue;
      valorPorSetor.set(setor, (valorPorSetor.get(setor) ?? 0) + (ganhoPorId.get(a.id)?.valorAtual ?? 0));
    }

    const alocacoesAlvo = new Map((config?.alocacoesSetor ?? []).map((a) => [a.setor, a.percentual]));
    const percentualEstouro = config?.percentualEstouro ?? PERCENTUAL_ESTOURO_PADRAO;

    const acoesPorSetor = new Map<string, AcaoContextoSetor[]>();
    for (const a of acoesInv) {
      const ticker = a.ticker as string;
      const setor = setorPorTicker.get(ticker) ?? null;
      if (!setor) continue;
      const s = scorePorTicker.get(ticker);
      if (!acoesPorSetor.has(setor)) acoesPorSetor.set(setor, []);
      acoesPorSetor.get(setor)!.push({
        id: a.id,
        ticker,
        scoreFinal: s?.scoreFinal ?? null,
        scoreQualidade: s?.scoreQualidade ?? null,
        scorePreco: s?.scorePreco ?? null,
      });
    }

    return {
      acoes: acoesInv.map((a) => ({ id: a.id, ticker: a.ticker as string })),
      valorTotalAcoes,
      valorPorSetor,
      alocacoesAlvo,
      percentualEstouro,
      acoesPorSetor,
    };
  }

  /**
   * Rateia um valor disponível (déficit de rebalanceamento OU aporte novo) entre as ações
   * qualificadas (scoreQualidade >= corteQualidadeSplitAporte) de UM setor, proporcional ao
   * scorePreco — quanto maior o desconto, maior a fatia. Se nenhuma ação do setor passar no
   * corte de qualidade, ou nenhuma tiver scorePreco, o rateio cai pra todas em partes iguais.
   * Extraído de getRecomendacoes pra ser reusado também pelo aporte semanal da simulação
   * (SimulacaoService.aplicarAporteSemanal), que precisa do mesmo rateio alimentado por caixa
   * novo em vez de déficit de venda.
   */
  calcularValorCompraPorSetor(
    acoesDoSetor: AcaoContextoSetor[],
    valorDisponivel: number,
    corteQualidadeSplitAporte = CORTE_QUALIDADE_SPLIT_APORTE_PADRAO,
  ): Map<string, number> {
    const qualificadas = acoesDoSetor.filter(
      (x) => (x.scoreQualidade ?? 0) >= corteQualidadeSplitAporte && x.scorePreco != null,
    );
    const base = qualificadas.length ? qualificadas : acoesDoSetor;
    const somaScorePreco = base.reduce((acc, x) => acc + (x.scorePreco ?? 0), 0);

    const resultado = new Map<string, number>();
    for (const x of base) {
      const proporcao = somaScorePreco > 0 ? (x.scorePreco ?? 0) / somaScorePreco : 1 / base.length;
      resultado.set(x.id, valorDisponivel * proporcao);
    }
    return resultado;
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
   *    em cada ação (ver calcularValorCompraPorSetor). Dentro da banda = setor "equilibrado",
   *    sem sugestão de rebalanceamento.
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
    carteira: TipoCarteira = CARTEIRA_PADRAO,
    corteQualidadeSplitAporte = CORTE_QUALIDADE_SPLIT_APORTE_PADRAO,
  ): Promise<RecomendacaoHolding[]> {
    const contexto = await this.construirContextoRebalanceamento(userId, anoMes, carteira);
    if (!contexto) return [];
    const { valorTotalAcoes, valorPorSetor, alocacoesAlvo, percentualEstouro, acoesPorSetor } = contexto;

    // Precisamos de alguns dados extras (nome/segmento, score completo, tipoRanking, hibridoRows)
    // que construirContextoRebalanceamento não expõe pra manter o contexto enxuto — busca de novo
    // aqui é barato (mesmas queries, já cacheadas pelo Postgres/connection pool) e evita inflar
    // ContextoRebalanceamento com campos que só getRecomendacoes usa.
    const investimentos = await this.listar(userId, carteira);
    const acoes = investimentos.filter((i) => i.tipo === 'acao' && i.ticker);
    if (!acoes.length) return [];

    // Ganho de CADA posição — usado tanto pro cap de venda (abaixo) quanto pro arredondamento em
    // lote (cotacaoAtual/quantidade), sem isso uma venda de setor sobrealocado sugeria vender o
    // déficit do setor inteiro mesmo quando a ação escolhida vale menos que isso (bug real:
    // "Vender R$ 4.813,40" numa posição que só tinha R$ 3.997,00).
    const ganhos = await this.calcularGanhos(userId, anoMes, carteira);
    const ganhoPorId = new Map(ganhos.map((g) => [g.id, g]));

    const tickers = acoes.map((a) => a.ticker as string);
    const config = await this.prisma.portfolioConfig.findUnique({ where: { userId } });
    const tipoRanking = (config?.tipoRankingRecomendacao as TipoRankingRecomendacao) ?? TIPO_RANKING_PADRAO;
    const permiteFracionario = config?.permiteFracionario ?? true;

    const [acaoInfos, hibridoRows] = await Promise.all([
      this.prisma.acao.findMany({
        where: { ticker: { in: tickers } },
        select: { ticker: true, nome: true, setor: true, segmento: true },
      }),
      tipoRanking === 'hibrido' ? this.rankingQuery.getRankingHibrido(anoMes) : Promise.resolve(null),
    ]);

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
    const tickersJaPossuidos = new Set(tickers);

    // Setores sobrealocados com mais de uma ação: escolhe a de menor scoreFinal pra vender.
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

    // Setores subalocados: rateia o déficit em R$ do setor entre as ações qualificadas
    // (ver calcularValorCompraPorSetor) — não duplica o valor total em cada ação.
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

      for (const [id, valor] of this.calcularValorCompraPorSetor(lista, deficitSetor, corteQualidadeSplitAporte)) {
        valorCompraPorAcao.set(id, valor);
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
            // Nunca sugere vender mais do que a própria posição vale — o déficit do setor pode
            // ser maior do que essa ação sozinha cobre; nesse caso a sugestão é vender tudo dela
            // (uma próxima chamada, já sem essa ação, recomendaria trimar a próxima do setor).
            const valorPosicaoAtual = ganhoPorId.get(a.id)?.valorAtual ?? ganhoPorId.get(a.id)?.valorInvestido ?? 0;
            valorSugerido = Math.min(valorAtualSetor - valorAlvoSetor, valorPosicaoAtual);
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

      // Lote-padrão B3 (100 ações) em vez de fracionário, se o usuário desativou em Carteira.
      // Converte o valor sugerido em quantidade pela cotação do mês, arredonda pra baixo, e
      // reconverte — se nem 1 lote couber no valor sugerido, suprime a sugestão (não faz sentido
      // recomendar comprar/vender uma fração de lote que o usuário não vai conseguir executar).
      if (!permiteFracionario && sugestaoRebalanceamento != null && valorSugerido != null) {
        const ganho = ganhoPorId.get(a.id);
        const cotacao = ganho?.cotacaoAtual ?? null;
        if (cotacao != null && cotacao > 0) {
          const quantidadeBruta = valorSugerido / cotacao;
          const quantidadeDisponivel = sugestaoRebalanceamento === 'vender' ? (ganho?.quantidade ?? null) : null;
          const quantidadeLote = arredondarParaLote(quantidadeBruta, quantidadeDisponivel);
          if (quantidadeLote <= 0) {
            sugestaoRebalanceamento = null;
            valorSugerido = null;
          } else {
            valorSugerido = quantidadeLote * cotacao;
          }
        }
      }

      const scoreFinal = score?.scoreFinal ?? null;
      const segmento = info?.segmento ?? null;

      // Melhor ticker do grupo definido por tipoRanking, EXCLUINDO só a própria ação avaliada
      // (não todos os já possuídos) — permite sugerir reforçar outra ação que você já tem e é
      // a melhor do grupo, em vez de forçar migração pra uma terceira ação nova só porque a
      // melhor de verdade já está na carteira. Buscado sempre que dá pra comparar (score do
      // próprio ticker conhecido), porque tanto a matriz quanto o pair trade "equilibrado"
      // precisam do delta de score pra decidir se troca vale a pena.
      const melhorDoGrupo =
        scoreFinal != null
          ? await this.buscarMelhorDoGrupo(tipoRanking, { setor, segmento }, anoMes, ticker, hibridoRows)
          : null;
      const alvoJaPossuido = melhorDoGrupo ? tickersJaPossuidos.has(melhorDoGrupo.ticker) : false;

      let categoriaAcao: CategoriaAcao = 'manter';
      let sugestaoTroca: RecomendacaoHolding['sugestaoTroca'] = null;
      let motivoTroca: string | null = null;
      let deltaScoreTroca: number | null = null;

      if (melhorDoGrupo && scoreFinal != null) {
        const scoreBaixo = scoreFinal < SCORE_BAIXO_MATRIZ;
        const deltaScore = melhorDoGrupo.scoreFinal != null ? melhorDoGrupo.scoreFinal - scoreFinal : null;

        if (statusSetor === 'subalocado' && scoreBaixo && sugestaoRebalanceamento === 'comprar') {
          categoriaAcao = 'aporte_direcionado';
          sugestaoTroca = melhorDoGrupo;
          motivoTroca = alvoJaPossuido
            ? 'Setor precisa de capital, mas direcione o aporte pra essa ação que você já possui em vez desse ticker'
            : 'Setor precisa de capital, mas considere aportar nesse ticker em vez do atual';
          deltaScoreTroca = deltaScore;
        } else if (statusSetor === 'sobrealocado' && scoreBaixo && escolhidaParaVender && sugestaoRebalanceamento === 'vender') {
          categoriaAcao = 'venda_prioritaria';
          sugestaoTroca = melhorDoGrupo;
          motivoTroca = alvoJaPossuido
            ? 'Ativo fraco em setor sobrealocado — venda prioritária, reforce a posição que você já tem nessa ação'
            : 'Ativo fraco em setor sobrealocado — venda prioritária, migre pra esse ticker';
          deltaScoreTroca = deltaScore;
        } else if (statusSetor === 'equilibrado' && deltaScore != null && deltaScore > DELTA_SCORE_TROCA) {
          categoriaAcao = 'troca_sugerida';
          sugestaoTroca = melhorDoGrupo;
          motivoTroca = alvoJaPossuido
            ? 'Score bem abaixo de outra ação que você já possui no mesmo grupo — considere realocar entre elas'
            : 'Score bem abaixo do melhor do setor — considere migrar mesmo com a alocação equilibrada';
          deltaScoreTroca = deltaScore;
        }
      }

      // Sem troca acionada — categoria cai pro rebalanceamento puro (ou "manter", já default).
      if (categoriaAcao === 'manter') {
        // sugestaoRebalanceamento pode ficar null mesmo com statusSetor 'subalocado' quando a
        // ação foi excluída do split por reprovar no filtro de qualidade (corteQualidadeSplitAporte).
        if (statusSetor === 'subalocado' && sugestaoRebalanceamento === 'comprar') categoriaAcao = 'aportar';
        else if (statusSetor === 'sobrealocado' && escolhidaParaVender && sugestaoRebalanceamento === 'vender') categoriaAcao = 'reducao_risco';
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
        prioridade: PRIORIDADE_POR_CATEGORIA[categoriaAcao],
      });
    }

    // Ordem de execução: prioridade (alta > média > baixa > sem prioridade) e, dentro do mesmo
    // tier, o maior volume em R$ primeiro (desempate tático — não é o critério principal, ver
    // discussão do Ranking de Prioridade: mover mais dinheiro só importa entre ações já no mesmo
    // nível de urgência).
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
   * "Melhor ticker do grupo" diferente da própria ação avaliada (tickerAtual), na fonte
   * definida por tipoRanking. Exclui só tickerAtual, não todos os já possuídos — o resultado
   * pode ser outra ação que você já tem, e nesse caso o chamador troca a mensagem pra "reforce
   * a posição existente" em vez de "migre pra esse ticker" (ver alvoJaPossuido em
   * getRecomendacoes).
   *
   * - 'setor'/'segmento': restrito à própria classificação da ação.
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
    tickerAtual: string,
    hibridoRows: Awaited<ReturnType<RankingQueryService['getRankingHibrido']>> | null,
  ): Promise<{ ticker: string; nome: string; scoreFinal: number | null } | null> {
    if (tipoRanking === 'hibrido') {
      const candidatos = (hibridoRows ?? [])
        .filter((r) => r.setor === acao.setor && r.ticker !== tickerAtual && r.scoreFinal != null)
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
        ticker: { not: tickerAtual },
      },
      orderBy: { scoreFinal: 'desc' },
      include: { acao: { select: { nome: true } } },
    });
    return melhor ? { ticker: melhor.ticker, nome: melhor.acao.nome, scoreFinal: melhor.scoreFinal } : null;
  }

  async garantirDono(userId: string, id: string, carteira: TipoCarteira = CARTEIRA_PADRAO) {
    const inv = await this.prisma.investimento.findUnique({ where: { id } });
    if (!inv || inv.userId !== userId || inv.carteira !== carteira) {
      throw new NotFoundException('Investimento não encontrado.');
    }
    return inv;
  }
}
