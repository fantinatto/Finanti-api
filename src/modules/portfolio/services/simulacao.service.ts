import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TransacaoSimulacao } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { InvestimentoService } from './investimento.service';
import { UpsertSimulacaoConfigDto } from '../dto/upsert-simulacao-config.dto';
import { UpsertInvestimentoDto } from '../dto/upsert-investimento.dto';
import { arredondarParaLote, TAMANHO_FRACIONARIO, TAMANHO_LOTE } from './lote';
import { PortfolioMove } from '../recommendation-engine/domain/portfolio-move';

/**
 * Únicas categorias de RecomendacaoHolding que representam uma venda real hoje.
 * 'aportar' orienta pra onde mandar o PRÓXIMO aporte — não uma ordem de venda da posição atual
 * (ver decisão registrada no plano da feature). Vender aqui criaria dinheiro do nada na simulação.
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

  /**
   * Cadastro manual de posição em Simulação (botão "Adicionar"/"Comprar") — diferente da carteira
   * real, aqui o valor investido (quantidade × precoMedio) sai do caixa disponível, senão a
   * compra "cria dinheiro do nada": o caixa só mudava em venda/aporte/executar-recomendação, nunca
   * quando o usuário registrava uma compra manual.
   *
   * Também grava TransacaoSimulacao (origem='manual') — é o único jeito do usuário ter um log de
   * "o que eu faria na carteira real" pra replicar manualmente lá (pedido explícito: um botão de
   * Adicionar sem rastro não dá pra reconstruir depois). `atualizar()` (edição) deliberadamente
   * NÃO gera transação — é tratado como correção da posição, não uma operação nova, mesmo
   * critério já usado em Fiscal (ver docs/FEATURE_SPEC_FISCAL.md seção 2).
   */
  async criar(userId: string, dto: UpsertInvestimentoDto, anoMes?: string) {
    const valorCompra = dto.quantidade * dto.precoMedio;
    const ticker = dto.tipo === 'renda_fixa' ? null : (dto.ticker?.toUpperCase() ?? null);

    return this.prisma.$transaction(async (tx) => {
      // Reforço de posição já existente (mesmo ticker/tipo) — soma quantidade e recalcula preço
      // médio ponderado, mesmo mecanismo de comprarOuReforcar; não é uma posição nova.
      const existente = ticker
        ? await tx.investimento.findFirst({ where: { userId, carteira: 'simulacao', tipo: dto.tipo, ticker } })
        : null;

      const investimento = existente
        ? await tx.investimento.update({
            where: { id: existente.id },
            data: {
              quantidade: existente.quantidade + dto.quantidade,
              precoMedio:
                (existente.quantidade * existente.precoMedio + dto.quantidade * dto.precoMedio) /
                (existente.quantidade + dto.quantidade),
            },
          })
        : await tx.investimento.create({
            data: {
              userId,
              carteira: 'simulacao',
              tipo: dto.tipo,
              ticker,
              nome: dto.nome,
              precoMedio: dto.precoMedio,
              quantidade: dto.quantidade,
            },
          });
      if (valorCompra !== 0) {
        await tx.simulacaoConfig.upsert({
          where: { userId },
          update: { caixaDisponivel: { decrement: valorCompra } },
          create: { userId, caixaDisponivel: -valorCompra },
        });
      }
      if (ticker) {
        await this.registrarTransacao(tx, {
          userId,
          anoMes: anoMes ?? new Date().toISOString().slice(0, 7),
          tipo: 'compra',
          ticker,
          quantidade: dto.quantidade,
          preco: dto.precoMedio,
          origem: 'manual',
          motivo: null,
        });
      }
      return investimento;
    });
  }

  /**
   * Edição manual de posição em Simulação — debita/credita o caixa pela VARIAÇÃO do valor
   * investido (novo − antigo), não pelo valor novo inteiro: reforçar (aumentar) debita como uma
   * compra, reduzir credita de volta (mesmo efeito de uma venda manual parcial via edição).
   */
  async atualizar(userId: string, id: string, dto: UpsertInvestimentoDto) {
    const atual = await this.investimentos.garantirDono(userId, id, 'simulacao');
    const delta = dto.quantidade * dto.precoMedio - atual.quantidade * atual.precoMedio;

    return this.prisma.$transaction(async (tx) => {
      const investimento = await tx.investimento.update({
        where: { id },
        data: {
          tipo: dto.tipo,
          ticker: dto.tipo === 'renda_fixa' ? null : (dto.ticker?.toUpperCase() ?? null),
          nome: dto.nome,
          precoMedio: dto.precoMedio,
          quantidade: dto.quantidade,
        },
      });
      if (delta !== 0) {
        await tx.simulacaoConfig.upsert({
          where: { userId },
          update: { caixaDisponivel: { decrement: delta } },
          create: { userId, caixaDisponivel: -delta },
        });
      }
      return investimento;
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
    const valorVendaAlvo = isTrocaTotal ? valorPosicaoAtual : Math.min(Math.abs(rec.valorSugerido ?? 0), valorPosicaoAtual);
    if (valorVendaAlvo <= 0) {
      throw new BadRequestException('Valor sugerido pra essa recomendação é zero — nada a executar.');
    }

    // troca_sugerida vende inv.quantidade inteira, seja lá qual for (mesmo fracionada por uma
    // compra antiga anterior a este fix — fechar 100% da posição nunca cria fração nova). Venda
    // PARCIAL (venda_prioritaria/reducao_risco) é arredondada pra baixo pro mesmo tamanho de
    // unidade da compra (1 ação ou lote de 100) — a B3 nunca negocia fração de ação em nenhum
    // mercado (bug real corrigido: uma venda saiu pedindo 864,2857142857142 ações).
    const tamanhoUnidade = permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;
    const qtdVenda = isTrocaTotal ? inv.quantidade : arredondarParaLote(valorVendaAlvo / cotacaoAtual, inv.quantidade, tamanhoUnidade);
    if (qtdVenda <= 0) {
      throw new BadRequestException('Valor sugerido pra essa recomendação é pequeno demais pra vender 1 ação inteira.');
    }
    // Valor real apurado, recalculado a partir da quantidade JÁ arredondada — nunca o valor-alvo
    // pré-arredondamento, senão o custo do lado da compra (e o ganho realizado abaixo) ficariam
    // levemente errados por causa da fração descartada no arredondamento da venda.
    const valorVenda = qtdVenda * cotacaoAtual;

    // Custo das ações vendidas ao precoMedio ANTES da venda (inv ainda não foi mutado aqui) —
    // sem gravar isso agora, o lucro "reseta" pra zero quando o valor for reinvestido
    // (comprarOuReforcar usa o valor da venda como novo custo de aquisição da posição de destino).
    const ganhoRealizadoVenda = valorVenda - qtdVenda * inv.precoMedio;

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
          ganhoRealizado: ganhoRealizadoVenda,
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
   * Aplica o aporte acumulado desde a última aplicação (ou desde o início da simulação, se nunca
   * aplicado) — credita direto em `caixaDisponivel`, NÃO compra nada sozinho (correção pedida
   * pelo usuário 2026-09-30: aporte semanal diluía automaticamente entre setores subalocados,
   * o mesmo rateio de `getRecomendacoes`; agora só acumula caixa, exatamente como o produto de
   * uma venda sem par — quem decide o que comprar com esse dinheiro é o usuário via "Investir
   * caixa" ou uma Next Best Action do motor novo). `anoMes` não é mais usado aqui (não compra
   * nada, não precisa de cotação) — mantido só pra não quebrar a rota que já o recebe.
   */
  async aplicarAporteSemanal(userId: string, _anoMes: string) {
    const config = await this.prisma.simulacaoConfig.findUnique({ where: { userId } });
    if (!config || config.aporteSemanalValor <= 0) {
      throw new BadRequestException('Configure um valor de aporte semanal antes de aplicar.');
    }

    const dataBase = config.ultimoAporteAplicadoEm ?? config.simulacaoIniciadaEm ?? new Date();
    const diasDesde = (Date.now() - dataBase.getTime()) / (1000 * 60 * 60 * 24);
    const semanas = Math.floor(diasDesde / 7);
    if (semanas <= 0) return { semanasAplicadas: 0, valorAportado: 0 };

    const valorTotalAporte = semanas * config.aporteSemanalValor;
    const atualizado = await this.prisma.simulacaoConfig.update({
      where: { userId },
      data: { ultimoAporteAplicadoEm: new Date(), caixaDisponivel: { increment: valorTotalAporte } },
    });
    return { semanasAplicadas: semanas, valorAportado: valorTotalAporte, caixaDisponivel: atualizado.caixaDisponivel };
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

  /**
   * acoesPorSetor só contém tickers já possuídos, então o aporte semanal sempre cai no ramo de
   * reforço (existente sempre encontrado); só executarRecomendacao pode bater no ramo de
   * criação, comprando um ticker novo via sugestaoTroca — por isso nomeSugerido é opcional.
   *
   * A quantidade é SEMPRE arredondada pra baixo pro múltiplo de `tamanhoUnidade` mais próximo —
   * 100 (lote-padrão) se `!permiteFracionario`, 1 ação inteira (mercado fracionário) se
   * `permiteFracionario` (ver arredondarParaLote/TAMANHO_FRACIONARIO). A B3 nunca negocia fração
   * de ação em nenhum mercado — o toggle só muda a granularidade, nunca "sem arredondar" (bug
   * real corrigido: uma compra chegou a sair com 864,2857142857142 ações). O valor que não
   * coube na unidade volta como `sobra` pro chamador decidir o que fazer (normalmente: creditar
   * em caixaDisponivel). Se nem 1 unidade couber, `transacao` vem null e `sobra` é o valorAporte
   * inteiro (nada foi comprado).
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
    idempotencyKey?: string,
  ): Promise<{ transacao: TransacaoSimulacao | null; sobra: number }> {
    const quantidadeBruta = valorAporte / cotacao;
    const tamanhoUnidade = permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;
    const qtd = arredondarParaLote(quantidadeBruta, null, tamanhoUnidade);
    const sobra = (quantidadeBruta - qtd) * cotacao;

    if (qtd <= 0) {
      return { transacao: null, sobra: valorAporte };
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

    const transacao = await this.registrarTransacao(tx, { userId, anoMes, tipo: 'compra', ticker, quantidade: qtd, preco: cotacao, origem, motivo, idempotencyKey });
    return { transacao, sobra };
  }

  /**
  * Compra/reforço a partir de um `PortfolioMove` do motor novo (Next Best Action) — mesmo
  * mecanismo de `comprarOuReforcar` (lote, cotação do mês, reforço/criação), só que abrindo sua
  * PRÓPRIA `$transaction` (o método privado espera um `tx` já aberto pelos fluxos antigos de
  * aporte semanal/investir caixa). O valor efetivamente comprado é debitado atomicamente do caixa;
  * a sobra do arredondamento permanece nele.
   */
  async executarCompraDoMotor(userId: string, ticker: string, valorAporte: number, anoMes: string, idempotencyKey?: string): Promise<{ transacao: TransacaoSimulacao | null; sobra: number }> {
    const cotacao = await this.buscarCotacao(ticker, anoMes);
    if (cotacao == null) {
      throw new BadRequestException(`Sem cotação de ${ticker} em ${anoMes} — não é possível executar.`);
    }
    const portfolioConfig = await this.prisma.portfolioConfig.findUnique({ where: { userId }, select: { permiteFracionario: true } });
    const permiteFracionario = portfolioConfig?.permiteFracionario ?? true;

    return this.prisma.$transaction(async (tx) => {
      const config = await tx.simulacaoConfig.findUnique({ where: { userId } });
      if (!config || config.caixaDisponivel <= 0) {
        throw new BadRequestException('Não há caixa disponível pra executar essa compra.');
      }

      const { transacao, sobra } = await this.comprarOuReforcar(tx, userId, ticker, valorAporte, cotacao, anoMes, 'motor', null, permiteFracionario, undefined, idempotencyKey);
      if (transacao) {
        // updateMany com condição de saldo evita caixa negativo inclusive se outra execução
        // consumir o saldo entre a leitura e o débito. O custo é o valor real após arredondar o lote.
        const debito = await tx.simulacaoConfig.updateMany({
          where: { userId, caixaDisponivel: { gte: transacao.valor } },
          data: { caixaDisponivel: { decrement: transacao.valor } },
        });
        if (debito.count !== 1) {
          throw new BadRequestException('Caixa disponível insuficiente para executar essa compra.');
        }
      }
      return { transacao, sobra };
    });
  }

  /** Busca uma transação já executada pela MESMA confirmação (idempotência — ver
   * RecommendationEngineService.executeNextBestAction). `null` se essa chave nunca foi usada. */
  async buscarTransacaoPorIdempotencyKey(idempotencyKey: string): Promise<TransacaoSimulacao | null> {
    return this.prisma.transacaoSimulacao.findUnique({ where: { idempotencyKey } });
  }

  /**
   * Dispatcher único de execução real de um `PortfolioMove` do motor novo — SELL/REDUCE
   * reaproveita `venderManual` tal qual (`sourcePositionId` já é o mesmo domínio de
   * `Investimento.id`); BUY/ADD_NEW_POSITION vai por `executarCompraDoMotor`.
   * `ROTATE_WITHIN_SECTOR` não tem bridge atômico venda+compra hoje — fora de escopo, erro
   * explícito em vez de executar só metade do move.
   *
   * `executionDifference` é sempre contra o que REALMENTE foi persistido, nunca contra o
   * estado hipotético do Search — lote/cotação/caixa disponível na hora de executar podem
   * mudar o número final (arredondamento, sobra por unidade). O PRÓXIMO snapshot (fora deste
   * método) sempre vem de `PortfolioSnapshotService.build()` lido do banco, nunca do
   * `StateTransition.apply` em memória.
   */
  async executarMoveDoMotor(
    userId: string,
    move: PortfolioMove,
    anoMes: string,
    idempotencyKey?: string,
  ): Promise<{ projectedMove: PortfolioMove; executedTransaction: TransacaoSimulacao; executionDifference: { quantityDiff: number; amountDiff: number } }> {
    let executedTransaction: TransacaoSimulacao | null;

    if (move.type === 'SELL' || move.type === 'REDUCE') {
      executedTransaction = await this.venderManual(userId, move.sourcePositionId!, move.quantity!, anoMes, idempotencyKey);
    } else if (move.type === 'BUY' || move.type === 'ADD_NEW_POSITION') {
      const { transacao } = await this.executarCompraDoMotor(userId, move.targetTicker!, move.amount, anoMes, idempotencyKey);
      executedTransaction = transacao;
    } else {
      throw new BadRequestException(`Execução real de ${move.type} ainda não é suportada — sem bridge atômico venda+compra pro motor novo.`);
    }

    if (!executedTransaction) {
      throw new BadRequestException(`${move.type} de ${move.targetTicker ?? move.sourceTicker} não gerou nenhuma transação (valor menor que 1 unidade após arredondamento).`);
    }

    return {
      projectedMove: move,
      executedTransaction,
      executionDifference: {
        quantityDiff: executedTransaction.quantidade - (move.quantity ?? 0),
        amountDiff: executedTransaction.valor - move.amount,
      },
    };
  }

  /**
   * Venda manual (não gerada por uma recomendação) — usuário decidiu vender por conta própria.
   * Mesmo mecanismo de executarRecomendacao pra não ficar inconsistente: registra
   * TransacaoSimulacao com ganhoRealizado apurado ao precoMedio ANTES da venda, e credita o
   * valor em caixaDisponivel (sem destino de reinvestimento automático — igual reducao_risco).
   */
  async venderManual(userId: string, investimentoId: string, quantidade: number, anoMes: string, idempotencyKey?: string) {
    const inv = await this.investimentos.garantirDono(userId, investimentoId, 'simulacao');
    if (quantidade <= 0) {
      throw new BadRequestException('Quantidade a vender precisa ser maior que zero.');
    }
    if (quantidade > inv.quantidade + MARGEM_ZERAR_POSICAO) {
      throw new BadRequestException(`Você só possui ${inv.quantidade} unidades — não é possível vender ${quantidade}.`);
    }

    const cotacaoAtual = await this.buscarCotacao(inv.ticker as string, anoMes);
    if (cotacaoAtual == null) {
      throw new BadRequestException(`Sem cotação de ${inv.ticker} em ${anoMes} — não é possível executar.`);
    }

    const valorVenda = quantidade * cotacaoAtual;
    const ganhoRealizadoVenda = valorVenda - quantidade * inv.precoMedio;

    return this.prisma.$transaction(async (tx) => {
      const restante = inv.quantidade - quantidade;
      if (restante <= MARGEM_ZERAR_POSICAO) {
        await tx.investimento.delete({ where: { id: inv.id } });
      } else {
        await tx.investimento.update({ where: { id: inv.id }, data: { quantidade: restante } });
      }

      const transacao = await this.registrarTransacao(tx, {
        userId,
        anoMes,
        tipo: 'venda',
        ticker: inv.ticker as string,
        quantidade,
        preco: cotacaoAtual,
        origem: idempotencyKey ? 'motor' : 'manual',
        motivo: null,
        ganhoRealizado: ganhoRealizadoVenda,
        idempotencyKey,
      });

      await tx.simulacaoConfig.upsert({
        where: { userId },
        update: { caixaDisponivel: { increment: valorVenda } },
        create: { userId, caixaDisponivel: valorVenda },
      });

      return transacao;
    });
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
      /** Só em vendas — ver comentário do campo no schema. Ausente em compras (fica null). */
      ganhoRealizado?: number;
      /** Só em execuções vindas do motor novo (Next Best Action) — ver
       * RecommendationEngineService.executeNextBestAction. */
      idempotencyKey?: string;
    },
  ) {
    return tx.transacaoSimulacao.create({ data: { ...dados, valor: dados.quantidade * dados.preco } });
  }

  /**
   * Soma de todo ganho realizado (vendas com lucro/prejuízo já apurado, ver ganhoRealizado)
   * desde o último "Reiniciar simulação" — reiniciar apaga TransacaoSimulacao, então a soma
   * sempre reflete só o ciclo atual, sem precisar de um contador separado pra zerar.
   */
  async getGanhoRealizado(userId: string): Promise<number> {
    const resultado = await this.prisma.transacaoSimulacao.aggregate({
      where: { userId, tipo: 'venda' },
      _sum: { ganhoRealizado: true },
    });
    return resultado._sum.ganhoRealizado ?? 0;
  }

  /** Log completo de tudo que já aconteceu na simulação (mais recente primeiro) — pra o usuário
   * replicar manualmente na carteira real. Sem filtro de anoMes de propósito: o ponto é dar uma
   * visão de tudo que já foi feito desde o último "Reiniciar simulação", não só o mês corrente. */
  async listarTransacoes(userId: string): Promise<TransacaoSimulacao[]> {
    return this.prisma.transacaoSimulacao.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async buscarCotacao(ticker: string, anoMes: string): Promise<number | null> {
    const indicador = await this.prisma.indicadorMensal.findUnique({ where: { ticker_anoMes: { ticker, anoMes } } });
    return indicador?.precoFechamento ?? null;
  }
}
