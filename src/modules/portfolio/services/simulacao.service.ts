import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TransacaoSimulacao } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { InvestimentoService } from './investimento.service';
import { UpsertSimulacaoConfigDto } from '../dto/upsert-simulacao-config.dto';
import { arredondarParaLote } from './lote';

/**
 * Únicas categorias de RecomendacaoHolding que representam uma venda real hoje.
 * 'aporte_direcionado'/'aportar' orientam pra onde mandar o PRÓXIMO aporte — não uma ordem de
 * venda da posição atual (ver decisão registrada no plano da feature). Vender aqui criaria
 * dinheiro do nada na simulação.
 */
const CATEGORIAS_EXECUTAVEIS = new Set(['venda_prioritaria', 'reducao_risco', 'troca_sugerida']);
/** Abaixo disso a posição residual após uma venda é considerada zerada (ruído de ponto flutuante). */
const MARGEM_ZERAR_POSICAO = 0.0001;

@Injectable()
export class SimulacaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly investimentos: InvestimentoService,
  ) {}

  async getConfig(userId: string) {
    const config = await this.prisma.simulacaoConfig.findUnique({ where: { userId } });
    return (
      config ?? {
        userId,
        aporteSemanalValor: 0,
        caixaDisponivel: 0,
        ultimoAporteAplicadoEm: null,
        simulacaoIniciadaEm: null,
      }
    );
  }

  async upsertConfig(userId: string, dto: UpsertSimulacaoConfigDto) {
    return this.prisma.simulacaoConfig.upsert({
      where: { userId },
      update: { aporteSemanalValor: dto.aporteSemanalValor },
      create: { userId, aporteSemanalValor: dto.aporteSemanalValor },
    });
  }

  /** Zera a simulação e clona a carteira real atual como novo ponto de partida. Ação destrutiva
   * — a confirmação (modal "tem certeza?") é responsabilidade do frontend. */
  async reiniciar(userId: string): Promise<void> {
    const real = await this.investimentos.listar(userId, 'real');
    if (!real.length) {
      throw new BadRequestException('Cadastre investimentos reais antes de simular.');
    }

    await this.prisma.$transaction([
      this.prisma.transacaoSimulacao.deleteMany({ where: { userId } }),
      this.prisma.historicoCarteira.deleteMany({ where: { userId, carteira: 'simulacao' } }),
      this.prisma.investimento.deleteMany({ where: { userId, carteira: 'simulacao' } }),
      this.prisma.investimento.createMany({
        data: real.map((r) => ({
          userId,
          carteira: 'simulacao',
          tipo: r.tipo,
          ticker: r.ticker,
          nome: r.nome,
          precoMedio: r.precoMedio,
          quantidade: r.quantidade,
        })),
      }),
      this.prisma.simulacaoConfig.upsert({
        where: { userId },
        update: { ultimoAporteAplicadoEm: null, simulacaoIniciadaEm: new Date(), caixaDisponivel: 0 },
        create: { userId, simulacaoIniciadaEm: new Date() },
      }),
    ]);
  }

  /**
   * Aplica à risca a recomendação de UM investimento da simulação: vende (parcial ou total,
   * conforme a categoria) e, se houver sugestão de troca, compra o destino com o valor
   * apurado na venda. Só aceita as 3 categorias com venda real — ver CATEGORIAS_EXECUTAVEIS.
   */
  async executarRecomendacao(userId: string, investimentoId: string, anoMes: string) {
    const inv = await this.investimentos.garantirDono(userId, investimentoId, 'simulacao');
    const recomendacoes = await this.investimentos.getRecomendacoes(userId, anoMes, 'simulacao');
    const rec = recomendacoes.find((r) => r.id === investimentoId);
    if (!rec) throw new NotFoundException('Recomendação não encontrada pra esse investimento nesse mês.');

    if (!CATEGORIAS_EXECUTAVEIS.has(rec.categoriaAcao)) {
      throw new BadRequestException(
        'Essa recomendação orienta pra onde direcionar seu próximo aporte — use "Aplicar aporte semanal" em vez de executar uma venda.',
      );
    }

    const cotacaoAtual = await this.buscarCotacao(inv.ticker as string, anoMes);
    if (cotacaoAtual == null) {
      throw new BadRequestException(`Sem cotação de ${inv.ticker} em ${anoMes} — não é possível executar.`);
    }

    const portfolioConfig = await this.prisma.portfolioConfig.findUnique({ where: { userId }, select: { permiteFracionario: true } });
    const permiteFracionario = portfolioConfig?.permiteFracionario ?? true;

    // troca_sugerida (pair trade em setor equilibrado) é sempre 100% da posição — por construção
    // valorSugerido só é preenchido nos ramos sobrealocado/subalocado de getRecomendacoes.
    const isTrocaTotal = rec.categoriaAcao === 'troca_sugerida';
    const valorPosicaoAtual = inv.quantidade * cotacaoAtual;
    const valorVenda = isTrocaTotal ? valorPosicaoAtual : Math.min(Math.abs(rec.valorSugerido ?? 0), valorPosicaoAtual);
    if (valorVenda <= 0) {
      throw new BadRequestException('Valor sugerido pra essa recomendação é zero — nada a executar.');
    }
    const qtdVenda = valorVenda / cotacaoAtual;

    // Cotação de destino buscada ANTES de abrir a transação interativa — round-trips extras
    // dentro da janela de uma $transaction contam pro timeout dela (P2028, visto em teste real
    // contra o pooler do Supabase em sa-east-1). Também deixa o BadRequest acontecer sem nunca
    // ter tocado o banco em modo de escrita.
    let cotacaoDestino: number | null = null;
    if (rec.sugestaoTroca) {
      cotacaoDestino = await this.buscarCotacao(rec.sugestaoTroca.ticker, anoMes);
      if (cotacaoDestino == null) {
        throw new BadRequestException(
          `Sem cotação de ${rec.sugestaoTroca.ticker} em ${anoMes} — venda abortada, destino de compra indisponível.`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const qtdRestante = inv.quantidade - qtdVenda;
      if (qtdRestante <= MARGEM_ZERAR_POSICAO) {
        await tx.investimento.delete({ where: { id: inv.id } });
      } else {
        await tx.investimento.update({ where: { id: inv.id }, data: { quantidade: qtdRestante } });
      }

      const transacoes = [
        await this.registrarTransacao(tx, {
          userId,
          anoMes,
          tipo: 'venda',
          ticker: inv.ticker as string,
          quantidade: qtdVenda,
          preco: cotacaoAtual,
          origem: 'recomendacao',
          motivo: rec.motivoTroca,
        }),
      ];

      let caixaGerado = 0;

      if (rec.sugestaoTroca && cotacaoDestino != null) {
        const { transacao, sobra } = await this.comprarOuReforcar(
          tx,
          userId,
          rec.sugestaoTroca.ticker,
          valorVenda,
          cotacaoDestino,
          anoMes,
          'recomendacao',
          rec.motivoTroca,
          permiteFracionario,
          rec.sugestaoTroca.nome,
        );
        if (transacao) transacoes.push(transacao);
        // Sobra do arredondamento em lote (ver arredondarParaLote) — não fica presa no ticker de
        // destino, some pro caixa igual a qualquer outro valor sem lugar pra ir.
        caixaGerado += sobra;
      } else {
        // reducao_risco não tem sugestaoTroca — o valor apurado vira caixa disponível em vez de
        // sumir da carteira simulada (bug real encontrado: sem isso, valorTotalAcoes encolhia e
        // inflava artificialmente o %-por-setor de TODOS os outros setores).
        caixaGerado += valorVenda;
      }

      if (caixaGerado > 0) {
        await tx.simulacaoConfig.upsert({
          where: { userId },
          update: { caixaDisponivel: { increment: caixaGerado } },
          create: { userId, caixaDisponivel: caixaGerado },
        });
      }

      return transacoes;
    });
  }

  /**
   * Aplica o aporte acumulado desde a última aplicação (ou desde o início da simulação, se
   * nunca aplicado), direcionando pro(s) setor(es) mais subalocado(s) — mesmo rateio
   * proporcional a scorePreco usado em getRecomendacoes (ver
   * InvestimentoService.calcularValorCompraPorSetor). Sem setor subalocado (carteira já
   * equilibrada), rateia proporcional ao valor atual de cada setor em vez de travar o aporte.
   */
  async aplicarAporteSemanal(userId: string, anoMes: string) {
    const config = await this.prisma.simulacaoConfig.findUnique({ where: { userId } });
    if (!config || config.aporteSemanalValor <= 0) {
      throw new BadRequestException('Configure um valor de aporte semanal antes de aplicar.');
    }

    const dataBase = config.ultimoAporteAplicadoEm ?? config.simulacaoIniciadaEm ?? new Date();
    const diasDesde = (Date.now() - dataBase.getTime()) / (1000 * 60 * 60 * 24);
    const semanas = Math.floor(diasDesde / 7);
    if (semanas <= 0) return { semanasAplicadas: 0, transacoes: [] };

    const valorTotalAporte = semanas * config.aporteSemanalValor;
    const planoDeCompra = await this.prepararPlanoDeAporte(userId, anoMes, valorTotalAporte);
    const portfolioConfig = await this.prisma.portfolioConfig.findUnique({ where: { userId }, select: { permiteFracionario: true } });
    const permiteFracionario = portfolioConfig?.permiteFracionario ?? true;

    return this.prisma.$transaction(
      async (tx) => {
        const transacoes: TransacaoSimulacao[] = [];
        let sobraTotal = 0;
        for (const item of planoDeCompra) {
          const { transacao, sobra } = await this.comprarOuReforcar(
            tx,
            userId,
            item.ticker,
            item.valor,
            item.cotacao,
            anoMes,
            'aporte_semanal',
            `Aporte semanal (${semanas} semana(s))`,
            permiteFracionario,
          );
          if (transacao) transacoes.push(transacao);
          sobraTotal += sobra; // arredondamento em lote (ver arredondarParaLote) — sobra vira caixa em vez de sumir
        }

        await tx.simulacaoConfig.update({
          where: { userId },
          data: { ultimoAporteAplicadoEm: new Date(), ...(sobraTotal > 0 ? { caixaDisponivel: { increment: sobraTotal } } : {}) },
        });
        return { semanasAplicadas: semanas, transacoes };
      },
      { timeout: 20000 },
    );
  }

  /**
   * Investe o caixa acumulado de vendas sem par (reducao_risco, ver executarRecomendacao) —
   * mesmo rateio proporcional por setor subalocado do aporte semanal, só que o valor de entrada
   * é o caixa parado em vez de dinheiro novo. Zera caixaDisponivel ao final.
   */
  async investirCaixa(userId: string, anoMes: string) {
    const config = await this.prisma.simulacaoConfig.findUnique({ where: { userId } });
    if (!config || config.caixaDisponivel <= 0) {
      throw new BadRequestException('Não há caixa disponível pra investir.');
    }

    const planoDeCompra = await this.prepararPlanoDeAporte(userId, anoMes, config.caixaDisponivel);
    const portfolioConfig = await this.prisma.portfolioConfig.findUnique({ where: { userId }, select: { permiteFracionario: true } });
    const permiteFracionario = portfolioConfig?.permiteFracionario ?? true;

    return this.prisma.$transaction(
      async (tx) => {
        const transacoes: TransacaoSimulacao[] = [];
        let sobraTotal = 0;
        for (const item of planoDeCompra) {
          const { transacao, sobra } = await this.comprarOuReforcar(
            tx,
            userId,
            item.ticker,
            item.valor,
            item.cotacao,
            anoMes,
            'caixa',
            'Investimento do caixa acumulado',
            permiteFracionario,
          );
          if (transacao) transacoes.push(transacao);
          sobraTotal += sobra; // arredondamento em lote (ver arredondarParaLote) — sobra continua em caixa em vez de sumir
        }

        await tx.simulacaoConfig.update({ where: { userId }, data: { caixaDisponivel: sobraTotal } });
        return { valorInvestido: config.caixaDisponivel - sobraTotal, transacoes };
      },
      { timeout: 20000 },
    );
  }

  /**
   * Rateia um valor (aporte semanal OU caixa acumulado — a origem do dinheiro não importa aqui)
   * entre os setores mais subalocados, proporcional ao déficit de cada um (ou ao valor atual,
   * se nenhum setor estiver subalocado — carteira já equilibrada). Busca as cotações ANTES de
   * qualquer transação — round-trips extras dentro de uma $transaction interativa contam pro
   * timeout dela (P2028, visto em teste real contra o pooler do Supabase: com só 3-4 setores já
   * estourava os 5s padrão do Prisma).
   */
  private async prepararPlanoDeAporte(
    userId: string,
    anoMes: string,
    valorTotalAporte: number,
  ): Promise<{ ticker: string; valor: number; cotacao: number }[]> {
    const contexto = await this.investimentos.construirContextoRebalanceamento(userId, anoMes, 'simulacao');
    if (!contexto) {
      throw new BadRequestException('Simulação sem ações cadastradas — não há setor pra direcionar o aporte.');
    }
    const { valorTotalAcoes, valorPorSetor, alocacoesAlvo, percentualEstouro, acoesPorSetor } = contexto;

    const deficitPorSetor = new Map<string, number>();
    for (const setor of acoesPorSetor.keys()) {
      const percentualAlvo = alocacoesAlvo.get(setor);
      if (percentualAlvo == null) continue;
      const valorAtual = valorPorSetor.get(setor) ?? 0;
      const percentualReal = valorTotalAcoes > 0 ? (valorAtual / valorTotalAcoes) * 100 : 0;
      if (percentualAlvo - percentualReal > percentualEstouro) {
        deficitPorSetor.set(setor, (percentualAlvo / 100) * valorTotalAcoes - valorAtual);
      }
    }

    const baseRateio = deficitPorSetor.size > 0 ? deficitPorSetor : valorPorSetor;
    const somaBase = [...baseRateio.values()].reduce((acc, v) => acc + v, 0);

    const alvoPorSetor = new Map<string, number>();
    for (const [setor, valorBase] of baseRateio) {
      const proporcao = somaBase > 0 ? valorBase / somaBase : 1 / baseRateio.size;
      alvoPorSetor.set(setor, valorTotalAporte * proporcao);
    }

    const planoDeCompra: { ticker: string; valor: number; cotacao: number }[] = [];
    for (const [setor, valorParaSetor] of alvoPorSetor) {
      if (valorParaSetor <= 0) continue;
      const acoesDoSetor = acoesPorSetor.get(setor) ?? [];
      const valorPorAcao = this.investimentos.calcularValorCompraPorSetor(acoesDoSetor, valorParaSetor);

      for (const [id, valor] of valorPorAcao) {
        const ticker = acoesDoSetor.find((a) => a.id === id)?.ticker;
        if (!ticker) continue;
        const cotacao = await this.buscarCotacao(ticker, anoMes);
        if (cotacao == null) continue; // pula ação sem cotação, não aborta o aporte inteiro
        planoDeCompra.push({ ticker, valor, cotacao });
      }
    }

    return planoDeCompra;
  }

  /** acoesPorSetor só contém tickers já possuídos, então o aporte semanal sempre cai no ramo de
   * reforço (existente sempre encontrado); só executarRecomendacao pode bater no ramo de
   * criação, comprando um ticker novo via sugestaoTroca — por isso nomeSugerido é opcional.
   *
   * Com permiteFracionario=false, a quantidade é arredondada pro múltiplo de 100 mais próximo
   * pra baixo (ver arredondarParaLote) — o valor que não coube em lote inteiro volta como
   * `sobra` pro chamador decidir o que fazer (normalmente: creditar em caixaDisponivel). Se nem
   * 1 lote couber, `transacao` vem null e `sobra` é o valorAporte inteiro (nada foi comprado).
   */
  private async comprarOuReforcar(
    tx: Prisma.TransactionClient,
    userId: string,
    ticker: string,
    valorAporte: number,
    cotacao: number,
    anoMes: string,
    origem: string,
    motivo: string | null,
    permiteFracionario: boolean,
    nomeSugerido?: string,
  ): Promise<{ transacao: TransacaoSimulacao | null; sobra: number }> {
    let qtd = valorAporte / cotacao;
    let sobra = 0;

    if (!permiteFracionario) {
      const qtdLote = arredondarParaLote(qtd, null);
      sobra = (qtd - qtdLote) * cotacao;
      qtd = qtdLote;
    }

    if (qtd <= 0) {
      return { transacao: null, sobra: sobra || valorAporte };
    }

    const existente = await tx.investimento.findFirst({ where: { userId, carteira: 'simulacao', ticker } });

    if (existente) {
      const novaQuantidade = existente.quantidade + qtd;
      const novoPrecoMedio = (existente.quantidade * existente.precoMedio + qtd * cotacao) / novaQuantidade;
      await tx.investimento.update({
        where: { id: existente.id },
        data: { quantidade: novaQuantidade, precoMedio: novoPrecoMedio },
      });
    } else {
      await tx.investimento.create({
        data: {
          userId,
          carteira: 'simulacao',
          tipo: 'acao',
          ticker,
          nome: nomeSugerido ?? ticker,
          precoMedio: cotacao,
          quantidade: qtd,
        },
      });
    }

    const transacao = await this.registrarTransacao(tx, { userId, anoMes, tipo: 'compra', ticker, quantidade: qtd, preco: cotacao, origem, motivo });
    return { transacao, sobra };
  }

  private async registrarTransacao(
    tx: Prisma.TransactionClient,
    dados: {
      userId: string;
      anoMes: string;
      tipo: string;
      ticker: string;
      quantidade: number;
      preco: number;
      origem: string;
      motivo: string | null;
    },
  ) {
    return tx.transacaoSimulacao.create({ data: { ...dados, valor: dados.quantidade * dados.preco } });
  }

  private async buscarCotacao(ticker: string, anoMes: string): Promise<number | null> {
    const indicador = await this.prisma.indicadorMensal.findUnique({ where: { ticker_anoMes: { ticker, anoMes } } });
    return indicador?.precoFechamento ?? null;
  }
}
