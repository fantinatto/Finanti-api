import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RankingQueryService } from '../../market-data/services/ranking-query.service';
import { UpsertInvestimentoDto } from '../dto/upsert-investimento.dto';
import { arredondarParaLote, TAMANHO_FRACIONARIO, TAMANHO_LOTE } from './lote';

/** "real" | "simulacao" — mesma tabela Investimento, carteiras isoladas por usuário. Usado em
 * todo método público deste service pra filtrar/gravar na carteira certa. */
export type TipoCarteira = 'real' | 'simulacao';
const CARTEIRA_PADRAO: TipoCarteira = 'real';

/** Espelha PortfolioConfig.tipoRankingRecomendacao — qual ranking define "o melhor ticker do
 * grupo" e os scores usados pra decidir troca/split de aporte. Não afeta o rebalanceamento por
 * valor (sempre por setor, via AlocacaoSetor). */
export type TipoRankingRecomendacao = 'setor' | 'segmento' | 'geral' | 'hibrido';
const TIPO_RANKING_PADRAO: TipoRankingRecomendacao = 'setor';

export interface ScoreBasico {
  scoreFinal: number | null;
  scoreQualidade: number | null;
  scoreRisco: number | null;
  /** Δ como principal, clássico só de fallback — é o que de fato entra em scoreFinal (ver
   * normalizer.ts). Usado em getSaudeCarteira/simularImpactoCompra pra ficar consistente com o
   * que scoreFinal já usa, em vez de agregar o scoreRisco clássico (que não é o que pesa hoje). */
  riscoComposto: number | null;
  scorePreco: number | null;
  /** Campos abaixo existem nas 3 fontes que buscarScorePorTicker já retorna hoje (ScoreNormalizado
   * bruto pra setor/geral, ScoreComOrigem pro fallback de segmento, LinhaHibrida pro híbrido) —
   * só ficavam sem tipo aqui porque nada os lia ainda. Usados pelo motor de busca de estados
   * (PortfolioSnapshotService) desde a Fase A. Opcionais porque 'hibrido' não carrega origemScore. */
  qualidadeDelta?: number | null;
  riscoDelta?: number | null;
  precoDelta?: number | null;
  scoreFinalDelta?: number | null;
  origemScore?: 'segmento' | 'setor_fallback';
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
  | 'aportar' // subalocado, sem troca: reforçar o próprio ticker
  | 'troca_sugerida' // subalocado OU equilibrado + delta de score alto: rotação dentro do setor
  | 'venda_prioritaria' // sobrealocado + troca: score fraco, vender e migrar
  | 'reducao_risco' // sobrealocado, sem troca: realizar lucro parcial
  | 'aguardar_caixa' // sobrealocado, mas já há caixa parado suficiente pra financiar o subalocado
  | 'manter'; // nada a fazer

/**
 * Prioridade de execução — deriva 1:1 de categoriaAcao (função pura, ver PRIORIDADE_POR_CATEGORIA),
 * sem nenhum limiar novo: reaproveita a semântica que a própria matriz de decisão já carrega.
 * null só em 'manter' (nada a priorizar). Usado pra ordenar a lista de recomendações — ver o
 * final de getRecomendacoes — e pra badge de UX no front (Alta/Média/Baixa).
 *
 * - alta: venda_prioritaria (pior combinação: score fraco + setor sobrealocado) e troca_sugerida
 *   (só existe quando deltaScoreTroca > DELTA_SCORE_TROCA — oportunidade grande de qualidade,
 *   subalocado ou equilibrado) — as duas já são executáveis hoje (têm venda real associada).
 * - media: reducao_risco (executável, mas o ticker em si não é ruim — trim tático de tamanho de
 *   posição, não de qualidade).
 * - baixa: aportar (subalocado sem nenhum sinal de qualidade além de "o setor precisa de capital")
 *   e aguardar_caixa (nada a executar agora — o caixa parado já resolve, ver motivoTroca).
 */
export type PrioridadeAcao = 'alta' | 'media' | 'baixa';

export const PRIORIDADE_POR_CATEGORIA: Record<CategoriaAcao, PrioridadeAcao | null> = {
  venda_prioritaria: 'alta',
  troca_sugerida: 'alta',
  reducao_risco: 'media',
  aportar: 'baixa',
  aguardar_caixa: 'baixa',
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
  /** Quantidade de ações equivalente a valorSugerido, já arredondada pro lote/fracionário (ver
   * arredondarParaLote) — mesma unidade que seria de fato executada. Null sem sugestão. */
  quantidadeSugerida: number | null;
  /** Prioridade de execução — ver PrioridadeAcao. Null só em categoriaAcao='manter'. */
  prioridade: PrioridadeAcao | null;
}

/** Fallback quando o usuário não configurou percentualEstouro em Carteira. */
const PERCENTUAL_ESTOURO_PADRAO = 5;

/**
 * Matriz de decisão (status do setor × score do ticker) — ver getRecomendacoes. Dois gatilhos
 * independentes decidem troca, em QUALQUER status de setor (não só "equilibrado"): score
 * absoluto < SCORE_BAIXO_MATRIZ, OU delta contra o melhor do setor > DELTA_SCORE_TROCA. Só o
 * corte absoluto deixava passar batido um ticker "não-baixo mas claramente pior que o resto do
 * setor" (bug real: RANI3 com score 1,18 — acima do corte — recebendo "aportar" nele mesmo
 * enquanto CMIN3 no mesmo setor tinha 1,94, delta de +0,75).
 */
const SCORE_BAIXO_MATRIZ = 1.0;
/** Ticker muito atrás do melhor do setor/segmento, mesmo sem score baixo em termos absolutos — pair trade. */
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

export interface BalanceamentoSetor {
  setor: string;
  valorAtual: number;
  percentualAtual: number;
  percentualAlvo: number;
  /** percentualAtual − percentualAlvo. Positivo = sobrealocado, negativo = subalocado. */
  diferenca: number;
  status: 'sobrealocado' | 'subalocado' | 'equilibrado';
  /** true quando o setor tem alvo configurado mas ZERO ações hoje — "setor descoberto". */
  semNenhumaAcao: boolean;
}

/**
 * Qualidade/Risco/Preço/Final médios da carteira INTEIRA, ponderados pelo valor atual de cada
 * posição — complementa o Balanceamento por Setor (que olha só concentração) com uma leitura
 * de "a carteira como um todo é boa, arriscada ou cara?". `pesoX` é a soma do valor das ações
 * que efetivamente entraram naquela média específica (nem toda ação tem os 4 sub-scores
 * disponíveis) — serve tanto pra saber se a média é confiável (cobre pouco ou muito da
 * carteira) quanto de denominador em simularImpactoCompra.
 */
export interface SaudeCarteira {
  scoreQualidadeMedio: number | null;
  /** riscoComposto médio (Δ como principal) — consistente com o que scoreFinal já usa. */
  riscoCompostoMedio: number | null;
  scorePrecoMedio: number | null;
  scoreFinalMedio: number | null;
  pesoQualidade: number;
  pesoRisco: number;
  pesoPreco: number;
  pesoFinal: number;
  valorTotalCarteira: number;
}

/**
 * Simula "se eu colocar R$X em `ticker`, a saúde da carteira melhora ou piora?" — responde
 * "qual compra deixa a carteira melhor", não só "qual ticker tem score maior" (um candidato com
 * score final MAIOR mas Risco pior que o resto da carteira pode piorar o Risco médio, mesmo
 * melhorando o Final médio). Projeção simples: trata o aporte como mais um peso na média
 * ponderada existente, sem recalcular nada retroativamente.
 */
export interface ImpactoCarteira {
  ticker: string;
  valorAporte: number;
  antes: SaudeCarteira;
  depois: SaudeCarteira;
  deltaQualidade: number | null;
  deltaRisco: number | null;
  deltaPreco: number | null;
  deltaFinal: number | null;
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
   * Registra uma venda parcial/total na carteira REAL — só ajusta a quantidade (precoMedio do
   * que sobra não muda, vender não altera o custo médio das ações restantes). Sem histórico de
   * transação/ganho realizado: a carteira real é uma ficha manual do que o usuário possui hoje,
   * não um livro-razão. Zera a posição (remove a linha) se a quantidade vendida cobrir o total.
   * Simulação usa SimulacaoService.venderManual em vez deste método — lá uma venda precisa
   * gerar TransacaoSimulacao/ganhoRealizado/caixa pra não ficar inconsistente com o que
   * executarRecomendacao já registra.
   */
  async vender(userId: string, id: string, quantidade: number, carteira: TipoCarteira = CARTEIRA_PADRAO) {
    const inv = await this.garantirDono(userId, id, carteira);
    if (quantidade <= 0) {
      throw new BadRequestException('Quantidade a vender precisa ser maior que zero.');
    }
    if (quantidade > inv.quantidade + 0.0001) {
      throw new BadRequestException(`Você só possui ${inv.quantidade} unidades — não é possível vender ${quantidade}.`);
    }

    const restante = inv.quantidade - quantidade;
    if (restante <= 0.0001) {
      await this.prisma.investimento.delete({ where: { id } });
      return null;
    }
    return this.prisma.investimento.update({ where: { id }, data: { quantidade: restante } });
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

    const scorePorTicker: Map<string, ScoreBasico> = await this.buscarScorePorTicker(tipoRanking, anoMes, tickers, hibridoRows);

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
   * Quanto cada setor configurado representa hoje vs. o alvo — visão limpa em número e % pra
   * um painel de "carteira desbalanceada", sem precisar vasculhar a tabela de recomendações
   * ação por ação. Inclui setores com alvo configurado mas ZERO ações hoje ("setor descoberto",
   * `semNenhumaAcao: true`) — esses ficam sempre no topo da ordenação por serem o desvio máximo
   * possível (100% de déficit). Também inclui setores com ações mas sem alvo configurado
   * (`percentualAlvo: 0` — tudo ali conta como excesso, já que a meta é zero).
   */
  async getBalanceamentoPorSetor(userId: string, anoMes: string, carteira: TipoCarteira = CARTEIRA_PADRAO): Promise<BalanceamentoSetor[]> {
    const config = await this.prisma.portfolioConfig.findUnique({ where: { userId }, include: { alocacoesSetor: true } });
    const alocacoesAlvo = new Map((config?.alocacoesSetor ?? []).map((a) => [a.setor, a.percentual]));
    const percentualEstouro = config?.percentualEstouro ?? PERCENTUAL_ESTOURO_PADRAO;

    // construirContextoRebalanceamento retorna null quando não há NENHUMA ação na carteira — o
    // painel ainda precisa mostrar os alvos configurados como 100% subalocados nesse caso, então
    // não propaga o null, só trata valorPorSetor/valorTotalAcoes como vazios.
    const contexto = await this.construirContextoRebalanceamento(userId, anoMes, carteira);
    const valorPorSetor = contexto?.valorPorSetor ?? new Map<string, number>();
    const valorTotalAcoes = contexto?.valorTotalAcoes ?? 0;

    const setores = new Set([...alocacoesAlvo.keys(), ...valorPorSetor.keys()]);

    const resultado: BalanceamentoSetor[] = [];
    for (const setor of setores) {
      const valorAtual = valorPorSetor.get(setor) ?? 0;
      const percentualAtual = valorTotalAcoes > 0 ? (valorAtual / valorTotalAcoes) * 100 : 0;
      const percentualAlvo = alocacoesAlvo.get(setor) ?? 0;
      const diferenca = percentualAtual - percentualAlvo;

      let status: BalanceamentoSetor['status'] = 'equilibrado';
      if (diferenca > percentualEstouro) status = 'sobrealocado';
      else if (diferenca < -percentualEstouro) status = 'subalocado';

      resultado.push({
        setor,
        valorAtual,
        percentualAtual,
        percentualAlvo,
        diferenca,
        status,
        semNenhumaAcao: valorAtual <= 0 && percentualAlvo > 0,
      });
    }

    return resultado.sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca));
  }

  /**
   * Qualidade/Risco/Preço/Final médios da carteira, ponderados pelo valor atual de cada posição
   * (ver SaudeCarteira). Reusa buscarScorePorTicker — mesma fonte (setor/segmento/geral/híbrido,
   * com fallback de amostra pequena) que getRecomendacoes já usa, pra não ter dois critérios de
   * "qual é o score de um ticker" coexistindo no mesmo módulo.
   */
  async getSaudeCarteira(userId: string, anoMes: string, carteira: TipoCarteira = CARTEIRA_PADRAO): Promise<SaudeCarteira> {
    const vazio: SaudeCarteira = {
      scoreQualidadeMedio: null,
      riscoCompostoMedio: null,
      scorePrecoMedio: null,
      scoreFinalMedio: null,
      pesoQualidade: 0,
      pesoRisco: 0,
      pesoPreco: 0,
      pesoFinal: 0,
      valorTotalCarteira: 0,
    };

    const investimentos = await this.listar(userId, carteira);
    const acoes = investimentos.filter((i) => i.tipo === 'acao' && i.ticker);
    const ganhos = await this.calcularGanhos(userId, anoMes, carteira);
    const valorTotalCarteira = ganhos.reduce((acc, g) => acc + (g.valorAtual ?? g.valorInvestido), 0);
    if (!acoes.length) return { ...vazio, valorTotalCarteira };

    const ganhoPorId = new Map(ganhos.map((g) => [g.id, g]));
    const tickers = acoes.map((a) => a.ticker as string);
    const config = await this.prisma.portfolioConfig.findUnique({ where: { userId } });
    const tipoRanking = (config?.tipoRankingRecomendacao as TipoRankingRecomendacao) ?? TIPO_RANKING_PADRAO;
    const hibridoRows = tipoRanking === 'hibrido' ? await this.rankingQuery.getRankingHibrido(anoMes) : null;
    const scorePorTicker = await this.buscarScorePorTicker(tipoRanking, anoMes, tickers, hibridoRows);

    let somaQualidade = 0, somaRisco = 0, somaPreco = 0, somaFinal = 0;
    let pesoQualidade = 0, pesoRisco = 0, pesoPreco = 0, pesoFinal = 0;

    for (const a of acoes) {
      const score = scorePorTicker.get(a.ticker as string);
      const valorAtual = ganhoPorId.get(a.id)?.valorAtual;
      if (!score || valorAtual == null || valorAtual <= 0) continue;

      if (score.scoreQualidade != null) { somaQualidade += valorAtual * score.scoreQualidade; pesoQualidade += valorAtual; }
      if (score.riscoComposto != null) { somaRisco += valorAtual * score.riscoComposto; pesoRisco += valorAtual; }
      if (score.scorePreco != null) { somaPreco += valorAtual * score.scorePreco; pesoPreco += valorAtual; }
      if (score.scoreFinal != null) { somaFinal += valorAtual * score.scoreFinal; pesoFinal += valorAtual; }
    }

    return {
      scoreQualidadeMedio: pesoQualidade > 0 ? somaQualidade / pesoQualidade : null,
      riscoCompostoMedio: pesoRisco > 0 ? somaRisco / pesoRisco : null,
      scorePrecoMedio: pesoPreco > 0 ? somaPreco / pesoPreco : null,
      scoreFinalMedio: pesoFinal > 0 ? somaFinal / pesoFinal : null,
      pesoQualidade,
      pesoRisco,
      pesoPreco,
      pesoFinal,
      valorTotalCarteira,
    };
  }

  /**
   * "Se eu colocar R$X em `ticker`, a carteira fica melhor ou pior?" — ver ImpactoCarteira.
   * Projeção simples (trata o aporte como mais um peso na média existente, sem recalcular nada
   * retroativamente); não precisa o ticker já estar na carteira, só ter score calculado nesse mês.
   */
  async simularImpactoCompra(
    userId: string,
    anoMes: string,
    ticker: string,
    valorAporte: number,
    carteira: TipoCarteira = CARTEIRA_PADRAO,
  ): Promise<ImpactoCarteira> {
    if (valorAporte <= 0) {
      throw new BadRequestException('Valor do aporte simulado precisa ser maior que zero.');
    }

    const antes = await this.getSaudeCarteira(userId, anoMes, carteira);

    const config = await this.prisma.portfolioConfig.findUnique({ where: { userId } });
    const tipoRanking = (config?.tipoRankingRecomendacao as TipoRankingRecomendacao) ?? TIPO_RANKING_PADRAO;
    const hibridoRows = tipoRanking === 'hibrido' ? await this.rankingQuery.getRankingHibrido(anoMes) : null;
    const scorePorTicker = await this.buscarScorePorTicker(tipoRanking, anoMes, [ticker], hibridoRows);
    const score = scorePorTicker.get(ticker);
    if (!score) {
      throw new BadRequestException(`Sem score calculado pra ${ticker} em ${anoMes} — não dá pra simular o impacto.`);
    }

    // Sem esse sub-score pro candidato, a média desse eixo nem muda (nem peso nem soma) — mesmo
    // critério de "indicador ausente não vira valor inventado" do resto do motor de score.
    const projetar = (mediaAtual: number | null, pesoAtual: number, scoreNovo: number | null): number | null => {
      if (scoreNovo == null) return mediaAtual;
      if (mediaAtual == null || pesoAtual <= 0) return scoreNovo;
      return (mediaAtual * pesoAtual + scoreNovo * valorAporte) / (pesoAtual + valorAporte);
    };
    const somaPeso = (pesoAtual: number, scoreNovo: number | null): number => (scoreNovo != null ? pesoAtual + valorAporte : pesoAtual);

    const depois: SaudeCarteira = {
      scoreQualidadeMedio: projetar(antes.scoreQualidadeMedio, antes.pesoQualidade, score.scoreQualidade),
      riscoCompostoMedio: projetar(antes.riscoCompostoMedio, antes.pesoRisco, score.riscoComposto),
      scorePrecoMedio: projetar(antes.scorePrecoMedio, antes.pesoPreco, score.scorePreco),
      scoreFinalMedio: projetar(antes.scoreFinalMedio, antes.pesoFinal, score.scoreFinal),
      pesoQualidade: somaPeso(antes.pesoQualidade, score.scoreQualidade),
      pesoRisco: somaPeso(antes.pesoRisco, score.riscoComposto),
      pesoPreco: somaPeso(antes.pesoPreco, score.scorePreco),
      pesoFinal: somaPeso(antes.pesoFinal, score.scoreFinal),
      valorTotalCarteira: antes.valorTotalCarteira + valorAporte,
    };

    const delta = (a: number | null, b: number | null) => (a != null && b != null ? a - b : null);

    return {
      ticker,
      valorAporte,
      antes,
      depois,
      deltaQualidade: delta(depois.scoreQualidadeMedio, antes.scoreQualidadeMedio),
      deltaRisco: delta(depois.riscoCompostoMedio, antes.riscoCompostoMedio),
      deltaPreco: delta(depois.scorePrecoMedio, antes.scorePrecoMedio),
      deltaFinal: delta(depois.scoreFinalMedio, antes.scoreFinalMedio),
    };
  }

  /**
   * Score básico (Qualidade/Risco/Preço/Final) de cada ticker, na fonte definida por tipoRanking.
   * 'hibrido' usa as linhas já calculadas em getRankingHibrido (1 query só por chamada de
   * getRecomendacoes/construirContextoRebalanceamento, resultado passado pronto). 'segmento'
   * passa pelo fallback de amostra pequena (RankingQueryService.getScoresSegmentoComFallback) —
   * nunca expõe o score fixo e sem sentido de um segmento com menos de QTD_MINIMA_SEGMENTO
   * comparáveis (bug real confirmado: N=1 sempre produz scoreFinal=1,8 pra qualquer empresa).
   */
  /** Público (não mais `private`) desde a Fase A do motor de busca de estados — `PortfolioSnapshotService`
   * reusa esse método pra montar o score das posições possuídas, evitando duplicar a lógica de
   * fallback de segmento/híbrido em outro lugar. Ver docs/... motor de recomendações. */
  async buscarScorePorTicker(
    tipoRanking: TipoRankingRecomendacao,
    anoMes: string,
    tickers: string[],
    hibridoRows: Awaited<ReturnType<RankingQueryService['getRankingHibrido']>> | null,
  ): Promise<Map<string, ScoreBasico>> {
    if (tipoRanking === 'hibrido') {
      return new Map((hibridoRows ?? []).filter((r) => tickers.includes(r.ticker)).map((r) => [r.ticker, r]));
    }

    if (tipoRanking === 'segmento') {
      const fallback = await this.rankingQuery.getScoresSegmentoComFallback(anoMes);
      const resultado = new Map<string, ScoreBasico>();
      for (const ticker of tickers) {
        const s = fallback.get(ticker);
        if (s) resultado.set(ticker, s);
      }
      return resultado;
    }

    return new Map(
      (
        await this.prisma.scoreNormalizado.findMany({
          where: { tipoGrupo: tipoRanking, anoMes, ticker: { in: tickers } },
        })
      ).map((s) => [s.ticker, s]),
    );
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
   *    scoreFinal) sugerir troca. O gatilho é score baixo (<SCORE_BAIXO_MATRIZ) OU delta de
   *    score grande (>DELTA_SCORE_TROCA) contra o melhor do setor — só o corte absoluto deixava
   *    passar batido um ticker "não-baixo mas claramente pior" (bug real: RANI3 com score 1,18,
   *    acima do corte, recebendo "aportar" nele mesmo enquanto CMIN3 no mesmo setor tinha 1,94):
   *      - Subalocado + (score baixo OU delta grande): setor precisa de capital, mas não nesse
   *        ticker — sugere aportar no melhor do setor em vez de reforçar o atual.
   *      - Sobrealocado + (score baixo OU delta grande) NA AÇÃO ESCOLHIDA pra vender: venda
   *        prioritária, sugere migrar direto pro melhor do setor.
   *      - Equilibrado + delta de score > DELTA_SCORE_TROCA contra o melhor do setor: par de
   *        troca (pair trade) mesmo sem desalinhamento de alocação — o ticker ficou pra trás
   *        dentro do próprio setor.
   *      - Nenhum gatilho: sem troca, só o rebalanceamento de valor acima já resolve.
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

    const scorePorTicker: Map<string, ScoreBasico> = await this.buscarScorePorTicker(tipoRanking, anoMes, tickers, hibridoRows);

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

    // Caixa parado (só existe em Simulação — a carteira real não tem esse conceito) enquanto
    // ainda existe setor subalocado: vender por excesso setorial ignoraria dinheiro que já está
    // disponível pra fazer exatamente o trabalho que a venda faria (liberar capital pra
    // redirecionar) — pedido explícito do usuário: "caso eu tenha caixa e haja posições
    // Subalocado, priorizá-las" em vez de recomendar mais vendas.
    const caixaDisponivel =
      carteira === 'simulacao' ? ((await this.prisma.simulacaoConfig.findUnique({ where: { userId } }))?.caixaDisponivel ?? 0) : 0;

    // Mesma agregação já usada pro rateio de compra acima (valorPorSetor/alocacoesAlvo) — só
    // checa se ALGUM setor com alvo configurado está abaixo da banda de tolerância, sem refazer
    // nenhuma query nova.
    let existeSetorSubalocado = false;
    if (valorTotalAcoes > 0) {
      for (const [setor, percentualAlvo] of alocacoesAlvo) {
        const percentualReal = ((valorPorSetor.get(setor) ?? 0) / valorTotalAcoes) * 100;
        if (percentualAlvo - percentualReal > percentualEstouro) {
          existeSetorSubalocado = true;
          break;
        }
      }
    }

    const suprimirVendaPorCaixa = caixaDisponivel > 0 && existeSetorSubalocado;

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
      let quantidadeSugerida: number | null = null;
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
      // Converte o valor sugerido em quantidade pela cotação do mês e arredonda pra baixo —
      // SEMPRE, mesmo com permiteFracionario=true: a B3 nunca negocia fração de ação em nenhum
      // mercado (o fracionário permite 1-99 ações, mas inteiras; o padrão exige múltiplos de
      // 100). O toggle só muda a granularidade (1 ação vs. lote de 100), nunca "sem arredondar"
      // (bug real: sem isso, uma recomendação chegava a sugerir comprar 864,2857142857142 ações).
      // Se nem 1 unidade couber no valor sugerido, suprime a sugestão (não dá pra executar).
      if (sugestaoRebalanceamento != null && valorSugerido != null) {
        const ganho = ganhoPorId.get(a.id);
        const cotacao = ganho?.cotacaoAtual ?? null;
        if (cotacao != null && cotacao > 0) {
          const quantidadeBruta = valorSugerido / cotacao;
          const quantidadeDisponivel = sugestaoRebalanceamento === 'vender' ? (ganho?.quantidade ?? null) : null;
          const tamanhoUnidade = permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;
          const quantidadeArredondada = arredondarParaLote(quantidadeBruta, quantidadeDisponivel, tamanhoUnidade);
          if (quantidadeArredondada <= 0) {
            sugestaoRebalanceamento = null;
            valorSugerido = null;
          } else {
            valorSugerido = quantidadeArredondada * cotacao;
            quantidadeSugerida = quantidadeArredondada;
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
        // Corte absoluto OU relativo — um ticker "não-baixo" mas claramente pior que o melhor do
        // setor também deve acionar a troca, não só quem cruza o piso fixo de SCORE_BAIXO_MATRIZ.
        const scoreFracoOuAtrasado = scoreBaixo || (deltaScore != null && deltaScore > DELTA_SCORE_TROCA);

        // subalocado E equilibrado caem na MESMA ação (troca_sugerida) quando o gap de score é
        // grande o bastante — rotação dentro do setor nunca muda a alocação total dele (é só
        // recompor QUAL ticker segura o valor), então não precisa esperar o setor equilibrar pra
        // acontecer. Bug real reportado: setor subalocado recomendava só "aporte direcionado pro
        // melhor do setor" (deixando a posição fraca intocada); depois que o aporte fechava o
        // déficit e o setor virava equilibrado, a MESMA posição fraca passava a receber uma
        // recomendação de troca — ou seja, o usuário via primeiro "compre mais X" e só depois,
        // numa consulta futura, "ah, na verdade venda a posição antiga e compre mais X ainda".
        // Antecipar a troca pro Momento 0 evita esse round-trip. O texto do motivo deixa claro
        // que a rotação sozinha NÃO fecha o déficit do setor (isso continua visível no painel de
        // Balanceamento) — só melhora a composição interna, o aporte novo continua sendo
        // necessário depois.
        if (
          (statusSetor === 'subalocado' || statusSetor === 'equilibrado') &&
          deltaScore != null &&
          deltaScore > DELTA_SCORE_TROCA
        ) {
          categoriaAcao = 'troca_sugerida';
          sugestaoTroca = melhorDoGrupo;
          const baseMotivo = alvoJaPossuido
            ? 'Score bem abaixo de outra ação que você já possui no mesmo grupo — considere realocar entre elas'
            : 'Score bem abaixo do melhor do setor';
          motivoTroca =
            statusSetor === 'subalocado'
              ? `${baseMotivo}. Migre primeiro — a troca não muda a alocação do setor, então ainda vai ser preciso aportar capital novo depois pra fechar o déficit`
              : `${baseMotivo} — considere migrar mesmo com a alocação equilibrada`;
          deltaScoreTroca = deltaScore;
        } else if (statusSetor === 'sobrealocado' && scoreFracoOuAtrasado && escolhidaParaVender && sugestaoRebalanceamento === 'vender') {
          if (suprimirVendaPorCaixa) {
            categoriaAcao = 'aguardar_caixa';
            motivoTroca = `Setor sobrealocado e ativo fraco (score ${scoreFinal.toFixed(2)}), mas já existe caixa disponível suficiente pra investir nos setores subalocados — invista o caixa antes de vender`;
            sugestaoRebalanceamento = null;
            valorSugerido = null;
            quantidadeSugerida = null;
          } else {
            categoriaAcao = 'venda_prioritaria';
            // sugestaoTroca fica null DE PROPÓSITO — migrar pro melhor ticker do MESMO setor não
            // reduz desalinhamento nenhum, só troca qual ativo segura o excesso (bug real reportado:
            // setor sobrealocado a +10pp sugeria vender um ticker fraco pra migrar pro melhor
            // ticker do MESMO setor, que continuava sobrealocado do mesmo jeito depois). O valor
            // apurado deve sair do setor, não ser reinvestido nele — mesmo tratamento de
            // reducao_risco (vira caixa na Simulação, redirecionado depois pro setor subalocado
            // pelo motor de aporte, que já é sector-aware).
            motivoTroca = `Ativo fraco (score ${scoreFinal.toFixed(2)}) num setor já sobrealocado — venda prioritária; o valor deve ser redirecionado pra um setor subalocado, não reinvestido no mesmo setor`;
          }
        }
      }

      // Sem troca acionada — categoria cai pro rebalanceamento puro (ou "manter", já default).
      if (categoriaAcao === 'manter') {
        // sugestaoRebalanceamento pode ficar null mesmo com statusSetor 'subalocado' quando a
        // ação foi excluída do split por reprovar no filtro de qualidade (corteQualidadeSplitAporte).
        if (statusSetor === 'subalocado' && sugestaoRebalanceamento === 'comprar') categoriaAcao = 'aportar';
        else if (statusSetor === 'sobrealocado' && escolhidaParaVender && sugestaoRebalanceamento === 'vender') {
          if (suprimirVendaPorCaixa) {
            categoriaAcao = 'aguardar_caixa';
            motivoTroca = 'Setor sobrealocado, mas já existe caixa disponível suficiente pra investir nos setores subalocados — invista o caixa antes de vender';
            sugestaoRebalanceamento = null;
            valorSugerido = null;
            quantidadeSugerida = null;
          } else {
            categoriaAcao = 'reducao_risco';
          }
        }
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
        quantidadeSugerida,
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
