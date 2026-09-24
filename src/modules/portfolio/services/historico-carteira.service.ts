import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { InvestimentoService, TipoCarteira } from './investimento.service';

/**
 * Snapshot mensal de valor de carteira — base do gráfico de evolução em /investimentos e
 * /simulacao. Criado sob demanda (lazy) na primeira leitura de ganhos de cada mês, nunca por
 * cron — ver garantirSnapshotDoMes. Um mês já snapshotado nunca é sobrescrito: o valor fica
 * congelado no que a carteira tinha na primeira consulta daquele anoMes, é histórico, não um
 * valor "ao vivo" recalculável.
 */
@Injectable()
export class HistoricoCarteiraService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly investimentos: InvestimentoService,
  ) {}

  async garantirSnapshotDoMes(userId: string, carteira: TipoCarteira, anoMes: string): Promise<void> {
    const existente = await this.prisma.historicoCarteira.findUnique({
      where: { userId_carteira_anoMes: { userId, carteira, anoMes } },
    });
    if (existente) return;

    const ganhos = await this.investimentos.calcularGanhos(userId, anoMes, carteira);

    // Caixa parado (vendas sem par via reducao_risco — ver SimulacaoService.executarRecomendacao)
    // não pertence a nenhum holding, mas precisa entrar no valor total pra não sumir do gráfico
    // de evolução. Sua "cesta de custo" é o próprio valor em caixa (sem ganho/perda) — simplificação
    // deliberada: um ganho realizado antes de virar caixa fica "invisível" em ganhoAcumulado até
    // ser reinvestido, em vez de exigir uma contabilidade de custo separada só pra caixa.
    const caixaDisponivel =
      carteira === 'simulacao' ? (await this.prisma.simulacaoConfig.findUnique({ where: { userId } }))?.caixaDisponivel ?? 0 : 0;

    if (!ganhos.length && caixaDisponivel <= 0) return; // carteira vazia nesse mês — nada pra registrar ainda

    const somaPorTipo = (tipo: string) =>
      ganhos.filter((g) => g.tipo === tipo).reduce((acc, g) => acc + (g.valorAtual ?? g.valorInvestido), 0);
    const valorTotal = ganhos.reduce((acc, g) => acc + (g.valorAtual ?? g.valorInvestido), 0) + caixaDisponivel;
    const valorInvestidoTotal = ganhos.reduce((acc, g) => acc + g.valorInvestido, 0) + caixaDisponivel;

    await this.prisma.historicoCarteira.create({
      data: {
        userId,
        carteira,
        anoMes,
        valorTotal,
        valorInvestidoTotal,
        valorPorAcoes: somaPorTipo('acao'),
        valorPorFiis: somaPorTipo('fii'),
        valorPorRendaFixa: somaPorTipo('renda_fixa'),
        ganhoAcumulado: valorTotal - valorInvestidoTotal,
      },
    });
  }

  async listarHistorico(userId: string, carteira: TipoCarteira) {
    return this.prisma.historicoCarteira.findMany({
      where: { userId, carteira },
      orderBy: { anoMes: 'asc' },
    });
  }
}
