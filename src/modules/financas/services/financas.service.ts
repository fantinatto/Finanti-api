import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UpsertGastoDto } from '../dto/upsert-gasto.dto';
import { UpsertGanhoDto } from '../dto/upsert-ganho.dto';
import { AtualizarCategoriaTransacaoDto } from '../dto/atualizar-categoria-transacao.dto';
import { ImportacaoFaturaService } from './importacao-fatura.service';

/** Indicadores de qualidade financeira do mês — todos derivados de GastoMensal/GanhoMensal/
 * TransacaoCartao já buscados em getMes, sem tabela nova. Qualquer um pode vir null quando não
 * há base pra calcular (ex: sem ganhos ainda, ou sem mês anterior pra comparar) — null nunca é
 * "0", é "não dá pra saber ainda". */
export interface IndicadoresFinanceiros {
  /** saldo/totalGanhos×100 — quanto do que entrou sobrou. Null se totalGanhos=0. */
  taxaPoupanca: number | null;
  /** Variação % de totalGastos vs. o mês anterior. Positivo = gastou mais. Null sem mês
   * anterior com dado, ou se o mês anterior tinha totalGastos=0. */
  variacaoGastosMesAnterior: number | null;
  /** % das linhas de gasto já marcadas como pagas (contagem, não valor). Null sem nenhum gasto. */
  percentualContasPagas: number | null;
  /** Soma de TransacaoCartao do mês / totalGastos×100. Null sem nenhuma transação importada
   * nesse mês. */
  participacaoCartaoNoGasto: number | null;
}

export interface MesFinanceiro {
  gastos: Awaited<ReturnType<PrismaService['gastoMensal']['findMany']>>;
  ganhos: Awaited<ReturnType<PrismaService['ganhoMensal']['findMany']>>;
  totalGastos: number;
  totalGanhos: number;
  saldo: number;
  /** anoMes de onde os itens foram clonados, se o mês pedido estava vazio. Null quando o mês já
   * tinha lançamentos próprios (ou quando não há nenhum mês anterior pra clonar). */
  replicadoDe: string | null;
  /** Quando o mês foi "fechado" (ver fecharMes) — só um selo, nunca trava edição. Null = aberto. */
  fechadoEm: string | null;
  indicadores: IndicadoresFinanceiros;
}

export interface MesHistorico {
  anoMes: string;
  totalGastos: number;
  totalGanhos: number;
  saldo: number;
}

export interface ResumoCategoria {
  categoria: string;
  total: number;
}

@Injectable()
export class FinancasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importacaoFatura: ImportacaoFaturaService,
  ) {}

  /**
   * Busca os lançamentos do mês. Se o usuário nunca lançou nada em `anoMes`, clona do anoMes
   * mais recente anterior que tenha dados — nome/formaPagamento/valor como ponto de partida,
   * pago/recebido sempre reiniciados (um lançamento clonado começa pendente de revisão) e
   * dataVencimento nunca copiada (é uma data completa, não existe "mesma data" num mês
   * diferente — fica em branco pro usuário preencher).
   */
  async getMes(userId: string, anoMes: string): Promise<MesFinanceiro> {
    let [gastos, ganhos] = await Promise.all([
      this.prisma.gastoMensal.findMany({ where: { userId, anoMes }, orderBy: { ordem: 'asc' } }),
      this.prisma.ganhoMensal.findMany({ where: { userId, anoMes }, orderBy: { ordem: 'asc' } }),
    ]);

    let replicadoDe: string | null = null;

    if (gastos.length === 0 && ganhos.length === 0) {
      const [ultimoGasto, ultimoGanho] = await Promise.all([
        this.prisma.gastoMensal.findFirst({ where: { userId, anoMes: { lt: anoMes } }, orderBy: { anoMes: 'desc' } }),
        this.prisma.ganhoMensal.findFirst({ where: { userId, anoMes: { lt: anoMes } }, orderBy: { anoMes: 'desc' } }),
      ]);
      const anoMesOrigem = [ultimoGasto?.anoMes, ultimoGanho?.anoMes].filter((v): v is string => !!v).sort().reverse()[0] ?? null;

      if (anoMesOrigem) {
        const [gastosOrigem, ganhosOrigem] = await Promise.all([
          this.prisma.gastoMensal.findMany({ where: { userId, anoMes: anoMesOrigem }, orderBy: { ordem: 'asc' } }),
          this.prisma.ganhoMensal.findMany({ where: { userId, anoMes: anoMesOrigem }, orderBy: { ordem: 'asc' } }),
        ]);

        [gastos, ganhos] = await Promise.all([
          gastosOrigem.length
            ? this.prisma.gastoMensal
                .createMany({
                  data: gastosOrigem.map((g) => ({
                    userId,
                    anoMes,
                    nome: g.nome,
                    formaPagamento: g.formaPagamento,
                    valor: g.valor,
                    pago: false,
                    ordem: g.ordem,
                  })),
                })
                .then(() => this.prisma.gastoMensal.findMany({ where: { userId, anoMes }, orderBy: { ordem: 'asc' } }))
            : Promise.resolve(gastos),
          ganhosOrigem.length
            ? this.prisma.ganhoMensal
                .createMany({
                  data: ganhosOrigem.map((g) => ({ userId, anoMes, nome: g.nome, valor: g.valor, recebido: false, ordem: g.ordem })),
                })
                .then(() => this.prisma.ganhoMensal.findMany({ where: { userId, anoMes }, orderBy: { ordem: 'asc' } }))
            : Promise.resolve(ganhos),
        ]);

        replicadoDe = anoMesOrigem;
      }
    }

    const totalGastos = gastos.reduce((soma, g) => soma + g.valor, 0);
    const totalGanhos = ganhos.reduce((soma, g) => soma + g.valor, 0);

    const [fechamento, anoMesAnterior, somaCartaoMes] = await Promise.all([
      this.prisma.fechamentoMensal.findUnique({ where: { userId_anoMes: { userId, anoMes } } }),
      this.prisma.gastoMensal.findFirst({ where: { userId, anoMes: { lt: anoMes } }, orderBy: { anoMes: 'desc' }, select: { anoMes: true } }),
      this.prisma.transacaoCartao.aggregate({ where: { userId, anoMes }, _sum: { valor: true } }),
    ]);

    const totalGastosMesAnterior = anoMesAnterior
      ? (await this.prisma.gastoMensal.aggregate({ where: { userId, anoMes: anoMesAnterior.anoMes }, _sum: { valor: true } }))._sum.valor ?? 0
      : null;

    const totalPago = gastos.filter((g) => g.pago).length;
    const somaCartao = somaCartaoMes._sum.valor ?? 0;

    const indicadores: IndicadoresFinanceiros = {
      taxaPoupanca: totalGanhos > 0 ? ((totalGanhos - totalGastos) / totalGanhos) * 100 : null,
      variacaoGastosMesAnterior:
        totalGastosMesAnterior != null && totalGastosMesAnterior > 0
          ? ((totalGastos - totalGastosMesAnterior) / totalGastosMesAnterior) * 100
          : null,
      percentualContasPagas: gastos.length > 0 ? (totalPago / gastos.length) * 100 : null,
      participacaoCartaoNoGasto: somaCartao > 0 && totalGastos > 0 ? (somaCartao / totalGastos) * 100 : null,
    };

    return {
      gastos,
      ganhos,
      totalGastos,
      totalGanhos,
      saldo: totalGanhos - totalGastos,
      replicadoDe,
      fechadoEm: fechamento?.fechadoEm?.toISOString() ?? null,
      indicadores,
    };
  }

  async criarGasto(userId: string, anoMes: string, dto: UpsertGastoDto) {
    const ultimo = await this.prisma.gastoMensal.findFirst({ where: { userId, anoMes }, orderBy: { ordem: 'desc' } });
    return this.prisma.gastoMensal.create({
      data: {
        userId,
        anoMes,
        nome: dto.nome,
        formaPagamento: dto.formaPagamento ?? null,
        valor: dto.valor,
        pago: dto.pago ?? false,
        dataVencimento: dto.dataVencimento ? new Date(dto.dataVencimento) : null,
        ordem: (ultimo?.ordem ?? -1) + 1,
      },
    });
  }

  async atualizarGasto(userId: string, id: string, dto: UpsertGastoDto) {
    await this.garantirDonoGasto(userId, id);
    return this.prisma.gastoMensal.update({
      where: { id },
      data: {
        nome: dto.nome,
        formaPagamento: dto.formaPagamento ?? null,
        valor: dto.valor,
        pago: dto.pago ?? false,
        dataVencimento: dto.dataVencimento ? new Date(dto.dataVencimento) : null,
      },
    });
  }

  async removerGasto(userId: string, id: string): Promise<void> {
    await this.garantirDonoGasto(userId, id);
    await this.prisma.gastoMensal.delete({ where: { id } });
  }

  async criarGanho(userId: string, anoMes: string, dto: UpsertGanhoDto) {
    const ultimo = await this.prisma.ganhoMensal.findFirst({ where: { userId, anoMes }, orderBy: { ordem: 'desc' } });
    return this.prisma.ganhoMensal.create({
      data: { userId, anoMes, nome: dto.nome, valor: dto.valor, recebido: dto.recebido ?? false, ordem: (ultimo?.ordem ?? -1) + 1 },
    });
  }

  async atualizarGanho(userId: string, id: string, dto: UpsertGanhoDto) {
    await this.garantirDonoGanho(userId, id);
    return this.prisma.ganhoMensal.update({
      where: { id },
      data: { nome: dto.nome, valor: dto.valor, recebido: dto.recebido ?? false },
    });
  }

  async removerGanho(userId: string, id: string): Promise<void> {
    await this.garantirDonoGanho(userId, id);
    await this.prisma.ganhoMensal.delete({ where: { id } });
  }

  /** Selo de "revisei este mês" — upsert idempotente, nunca trava edição (ver decisão no plano
   * de 2026-10-16: reabrir é só desfazer o selo, sem reconciliação nenhuma). */
  async fecharMes(userId: string, anoMes: string): Promise<void> {
    await this.prisma.fechamentoMensal.upsert({
      where: { userId_anoMes: { userId, anoMes } },
      create: { userId, anoMes },
      update: {},
    });
  }

  async reabrirMes(userId: string, anoMes: string): Promise<void> {
    await this.prisma.fechamentoMensal.deleteMany({ where: { userId, anoMes } });
  }

  /** Últimos N meses com algum lançamento (gasto OU ganho), pro gráfico comparativo — meses sem
   * nenhum dos dois simplesmente não aparecem (não força zero artificial num mês que o usuário
   * nunca chegou a abrir). */
  async getHistorico(userId: string, meses = 12): Promise<MesHistorico[]> {
    const [gastosPorMes, ganhosPorMes] = await Promise.all([
      this.prisma.gastoMensal.groupBy({ by: ['anoMes'], where: { userId }, _sum: { valor: true } }),
      this.prisma.ganhoMensal.groupBy({ by: ['anoMes'], where: { userId }, _sum: { valor: true } }),
    ]);

    const totalGastosPorMes = new Map(gastosPorMes.map((g) => [g.anoMes, g._sum.valor ?? 0]));
    const totalGanhosPorMes = new Map(ganhosPorMes.map((g) => [g.anoMes, g._sum.valor ?? 0]));
    const todosMeses = [...new Set([...totalGastosPorMes.keys(), ...totalGanhosPorMes.keys()])].sort();

    return todosMeses.slice(-meses).map((anoMes) => {
      const totalGastos = totalGastosPorMes.get(anoMes) ?? 0;
      const totalGanhos = totalGanhosPorMes.get(anoMes) ?? 0;
      return { anoMes, totalGastos, totalGanhos, saldo: totalGanhos - totalGastos };
    });
  }

  /**
   * Importa uma fatura de cartão em PDF — extrai os lançamentos (ImportacaoFaturaService),
   * deduplica contra TransacaoCartao REAL já existente (mesma data+descrição+valor — reimportar
   * o mesmo PDF não duplica) e sugere `categoria` pelo nome (normalizado) da descrição, comparando
   * com transações JÁ categorizadas pelo próprio usuário em qualquer mês (aprende com o próprio
   * histórico, sem dicionário fixo). Sufixo de parcela ("- Parcela 2/4") é ignorado na comparação
   * de categoria, pra uma compra parcelada recorrente continuar casando mês a mês mesmo com o
   * número mudando.
   *
   * Se a linha importada corresponde a uma PROJEÇÃO já existente (ver preverParcelasFuturas),
   * a projeção é confirmada/atualizada no lugar (previsto -> false) em vez de criar duplicata.
   * Toda linha confirmada (nova OU já existente) que for parcela ainda não-final gera/atualiza
   * projeção das parcelas seguintes — reimportar um PDF já importado não duplica nada, mas ainda
   * assim roda a checagem de projeção (backfill pra dado importado antes desta funcionalidade
   * existir).
   */
  async importarFatura(userId: string, anoMes: string, buffer: Buffer, nomeArquivo: string): Promise<{ importadas: number; ignoradasDuplicadas: number }> {
    const extraidas = await this.importacaoFatura.extrairTransacoes(buffer);
    if (!extraidas.length) return { importadas: 0, ignoradasDuplicadas: 0 };

    // Dedupe isolado por anoMes (não globalmente) e só contra linhas REAIS — uma projeção
    // (previsto=true) nunca conta como "já existe", ela precisa ser confirmada, não pulada.
    const [existentesReais, previstosDoMes, categorizadas] = await Promise.all([
      this.prisma.transacaoCartao.findMany({
        where: { userId, anoMes, previsto: false, data: { in: extraidas.map((t) => t.data) } },
        select: { data: true, descricao: true, valor: true, categoria: true },
      }),
      this.prisma.transacaoCartao.findMany({
        where: { userId, anoMes, previsto: true, data: { in: extraidas.map((t) => t.data) } },
      }),
      this.prisma.transacaoCartao.findMany({
        where: { userId, categoria: { not: null } },
        select: { descricao: true, categoria: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const chaveExistente = (data: Date, descricao: string, valor: number) => `${data.getTime()}|${descricao}|${valor}`;
    const categoriaPorChaveExistente = new Map(
      existentesReais.map((e) => [chaveExistente(e.data, e.descricao, e.valor), e.categoria]),
    );
    const jaExisteReal = new Set(categoriaPorChaveExistente.keys());

    const categoriaPorDescricao = new Map<string, string>();
    for (const c of categorizadas) {
      const chave = this.normalizarDescricao(c.descricao);
      if (!categoriaPorDescricao.has(chave)) categoriaPorDescricao.set(chave, c.categoria as string);
    }

    const novas = extraidas.filter((t) => !jaExisteReal.has(chaveExistente(t.data, t.descricao, t.valor)));
    const duplicadas = extraidas.filter((t) => jaExisteReal.has(chaveExistente(t.data, t.descricao, t.valor)));

    const aCriar: { userId: string; anoMes: string; data: Date; descricao: string; valor: number; categoria: string | null; origemArquivo: string }[] = [];
    const confirmadas: { data: Date; descricao: string; valor: number; categoria: string | null }[] = [];

    // Linhas já existentes (reais) também entram na checagem de projeção — cobre o caso de dado
    // importado ANTES desta funcionalidade existir, sem projeção ainda gerada (backfill).
    for (const t of duplicadas) {
      confirmadas.push({
        data: t.data,
        descricao: t.descricao,
        valor: t.valor,
        categoria: categoriaPorChaveExistente.get(chaveExistente(t.data, t.descricao, t.valor)) ?? null,
      });
    }

    for (const t of novas) {
      const categoriaSugerida = categoriaPorDescricao.get(this.normalizarDescricao(t.descricao)) ?? null;
      const previsao = previstosDoMes.find(
        (p) => p.data.getTime() === t.data.getTime() && this.normalizarDescricao(p.descricao) === this.normalizarDescricao(t.descricao),
      );

      if (previsao) {
        const categoriaFinal = previsao.categoria ?? categoriaSugerida;
        await this.prisma.transacaoCartao.update({
          where: { id: previsao.id },
          data: { descricao: t.descricao, valor: t.valor, previsto: false, origemArquivo: nomeArquivo, categoria: categoriaFinal },
        });
        confirmadas.push({ data: t.data, descricao: t.descricao, valor: t.valor, categoria: categoriaFinal });
      } else {
        aCriar.push({ userId, anoMes, data: t.data, descricao: t.descricao, valor: t.valor, categoria: categoriaSugerida, origemArquivo: nomeArquivo });
        confirmadas.push({ data: t.data, descricao: t.descricao, valor: t.valor, categoria: categoriaSugerida });
      }
    }

    if (aCriar.length) await this.prisma.transacaoCartao.createMany({ data: aCriar });

    if (confirmadas.length) {
      await this.preverParcelasFuturas(userId, confirmadas.map((c) => ({ ...c, anoMesBase: anoMes })));
    }

    return { importadas: novas.length, ignoradasDuplicadas: duplicadas.length };
  }

  /**
   * Varre TODAS as transações REAIS já importadas (qualquer mês) e garante que parcelas ainda
   * não-finais tenham a projeção das parcelas seguintes gerada — pensado pra dado que já estava
   * no banco ANTES desta funcionalidade existir (não precisa reimportar nenhum PDF; é só rodar
   * esta varredura uma vez e as previsões aparecem retroativamente).
   */
  async recalcularPrevisoesParcelas(userId: string): Promise<{ criadas: number }> {
    const reais = await this.prisma.transacaoCartao.findMany({
      where: { userId, previsto: false },
      select: { anoMes: true, data: true, descricao: true, valor: true, categoria: true },
    });
    const criadas = await this.preverParcelasFuturas(
      userId,
      reais.map((t) => ({ ...t, anoMesBase: t.anoMes })),
    );
    return { criadas };
  }

  /**
   * Pra cada transação REAL que seja parcela ainda não-final ("- Parcela N/M" com N<M), projeta
   * as parcelas N+1..M nos meses seguintes (mesma data de compra, mesmo valor, mesma categoria,
   * descrição com o número da parcela atualizado) como linhas `previsto=true`. Idempotente: se a
   * projeção pro mês/descrição já existe (real ou já projetada), não duplica — só atualiza o
   * valor de uma projeção existente. Retorna quantas linhas novas foram criadas.
   */
  private async preverParcelasFuturas(
    userId: string,
    transacoes: { data: Date; descricao: string; valor: number; categoria: string | null; anoMesBase: string }[],
  ): Promise<number> {
    let criadas = 0;
    for (const t of transacoes) {
      const parcela = this.extrairParcela(t.descricao);
      if (!parcela || parcela.atual >= parcela.total) continue;

      for (let n = parcela.atual + 1; n <= parcela.total; n++) {
        const anoMesFuturo = this.incrementarAnoMes(t.anoMesBase, n - parcela.atual);
        const descricaoFutura = `${parcela.prefixo} - Parcela ${n}/${parcela.total}`;

        const existente = await this.prisma.transacaoCartao.findFirst({
          where: { userId, anoMes: anoMesFuturo, data: t.data, descricao: descricaoFutura },
        });

        if (!existente) {
          await this.prisma.transacaoCartao.create({
            data: {
              userId,
              anoMes: anoMesFuturo,
              data: t.data,
              descricao: descricaoFutura,
              valor: t.valor,
              categoria: t.categoria,
              previsto: true,
            },
          });
          criadas++;
        } else if (existente.previsto && existente.valor !== t.valor) {
          await this.prisma.transacaoCartao.update({ where: { id: existente.id }, data: { valor: t.valor } });
        }
      }
    }
    return criadas;
  }

  async listarTransacoesCartao(userId: string, anoMes: string) {
    return this.prisma.transacaoCartao.findMany({ where: { userId, anoMes }, orderBy: { data: 'asc' } });
  }

  async atualizarCategoriaTransacao(userId: string, id: string, dto: AtualizarCategoriaTransacaoDto) {
    await this.garantirDonoTransacaoCartao(userId, id);
    return this.prisma.transacaoCartao.update({ where: { id }, data: { categoria: dto.categoria ?? null } });
  }

  async removerTransacaoCartao(userId: string, id: string): Promise<void> {
    await this.garantirDonoTransacaoCartao(userId, id);
    await this.prisma.transacaoCartao.delete({ where: { id } });
  }

  /** Marcador livre de "não reconheço esta compra", pra validar depois (ex: conferir fatura
   * física, checar se é fraude ou assinatura esquecida) — não afeta categoria nem dedupe. */
  async marcarNaoReconhecida(userId: string, id: string, naoReconhecida: boolean) {
    await this.garantirDonoTransacaoCartao(userId, id);
    return this.prisma.transacaoCartao.update({ where: { id }, data: { naoReconhecida } });
  }

  async getResumoCategoria(userId: string, anoMes: string): Promise<ResumoCategoria[]> {
    const transacoes = await this.prisma.transacaoCartao.findMany({ where: { userId, anoMes }, select: { categoria: true, valor: true } });
    const totalPorCategoria = new Map<string, number>();
    for (const t of transacoes) {
      const categoria = t.categoria ?? 'Sem categoria';
      totalPorCategoria.set(categoria, (totalPorCategoria.get(categoria) ?? 0) + t.valor);
    }
    return [...totalPorCategoria.entries()].map(([categoria, total]) => ({ categoria, total })).sort((a, b) => b.total - a.total);
  }

  /** Extrai "PREFIXO - Parcela N/M" — null se a descrição não tiver esse padrão (compra à vista). */
  private extrairParcela(descricao: string): { prefixo: string; atual: number; total: number } | null {
    const match = descricao.match(/^(.*?)\s*-\s*Parcela\s*(\d+)\/(\d+)\s*$/i);
    if (!match) return null;
    return { prefixo: match[1].trim(), atual: Number(match[2]), total: Number(match[3]) };
  }

  private incrementarAnoMes(anoMes: string, meses: number): string {
    const [ano, mes] = anoMes.split('-').map(Number);
    const data = new Date(ano, mes - 1 + meses, 1);
    return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
  }

  private normalizarDescricao(descricao: string): string {
    return descricao
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*-?\s*PARCELA\s*\d+\/\d+\s*$/i, '')
      .trim();
  }

  private async garantirDonoTransacaoCartao(userId: string, id: string) {
    const transacao = await this.prisma.transacaoCartao.findUnique({ where: { id } });
    if (!transacao || transacao.userId !== userId) throw new NotFoundException('Transação não encontrada.');
    return transacao;
  }

  private async garantirDonoGasto(userId: string, id: string) {
    const gasto = await this.prisma.gastoMensal.findUnique({ where: { id } });
    if (!gasto || gasto.userId !== userId) throw new NotFoundException('Gasto não encontrado.');
    return gasto;
  }

  private async garantirDonoGanho(userId: string, id: string) {
    const ganho = await this.prisma.ganhoMensal.findUnique({ where: { id } });
    if (!ganho || ganho.userId !== userId) throw new NotFoundException('Ganho não encontrado.');
    return ganho;
  }
}
