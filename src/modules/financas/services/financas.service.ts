import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UpsertGastoDto } from '../dto/upsert-gasto.dto';
import { UpsertGanhoDto } from '../dto/upsert-ganho.dto';

export interface MesFinanceiro {
  gastos: Awaited<ReturnType<PrismaService['gastoMensal']['findMany']>>;
  ganhos: Awaited<ReturnType<PrismaService['ganhoMensal']['findMany']>>;
  totalGastos: number;
  totalGanhos: number;
  saldo: number;
  /** anoMes de onde os itens foram clonados, se o mês pedido estava vazio. Null quando o mês já
   * tinha lançamentos próprios (ou quando não há nenhum mês anterior pra clonar). */
  replicadoDe: string | null;
}

@Injectable()
export class FinancasService {
  constructor(private readonly prisma: PrismaService) {}

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

    return { gastos, ganhos, totalGastos, totalGanhos, saldo: totalGanhos - totalGastos, replicadoDe };
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
