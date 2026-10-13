import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { InvestimentoService, TipoCarteira } from './investimento.service';

/**
 * Snapshot mensal de valor de carteira — base do gráfico de evolução em /investimentos e
 * /simulacao. Criado sob demanda (lazy) na primeira leitura de ganhos de cada mês, nunca por
 * cron — ver garantirSnapshotDoMes. Um mês PASSADO já snapshotado nunca é sobrescrito: o valor
 * fica congelado no que a carteira tinha, é histórico, não um valor "ao vivo" recalculável — uma
 * compra feita hoje não deve inflar retroativamente o valor registrado de um mês que já fechou.
 *
 * O mês ATUAL (ainda em curso) é exceção — ver comentário dentro de garantirSnapshotDoMes:
 * sempre recalcula, nunca congela, porque ainda não "fechou" (bug real, 2026-10-10: snapshot de
 * outubro foi tirado em 01/10 só com ações; FIIs cadastrados em 08/10 e Renda Fixa em 10/10
 * ficaram fora do gráfico de Evolução pro resto do mês inteiro).
 */
@Injectable()
export class HistoricoCarteiraService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly investimentos: InvestimentoService,
  ) {}

  async garantirSnapshotDoMes(userId: string, carteira: TipoCarteira, anoMes: string): Promise<void> {
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const ehMesAtual = anoMes === anoMesAtual;

    // Mês passado: só cria se ainda não existe (congelado pra sempre). Mês atual: sempre
    // recalcula — pode já existir uma linha de uma leitura anterior do mesmo dia/mês, mas ela
    // nunca reflete posições adicionadas depois (ver comentário da classe).
    if (!ehMesAtual) {
      const existente = await this.prisma.historicoCarteira.findUnique({
        where: { userId_carteira_anoMes: { userId, carteira, anoMes } },
      });
      if (existente) return;
    }

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

    const dados = {
      valorTotal,
      valorInvestidoTotal,
      valorPorAcoes: somaPorTipo('acao'),
      valorPorFiis: somaPorTipo('fii'),
      valorPorRendaFixa: somaPorTipo('renda_fixa'),
      ganhoAcumulado: valorTotal - valorInvestidoTotal,
    };

    // upsert (não create) — o mês atual pode já ter uma linha de uma leitura anterior do mesmo
    // mês que precisa ser substituída (ver ehMesAtual acima); mês passado nunca chega aqui tendo
    // linha existente (já retornou antes), então o upsert nesse caso sempre cria.
    await this.prisma.historicoCarteira.upsert({
      where: { userId_carteira_anoMes: { userId, carteira, anoMes } },
      create: { userId, carteira, anoMes, ...dados },
      update: dados,
    });
  }

  async listarHistorico(userId: string, carteira: TipoCarteira) {
    return this.prisma.historicoCarteira.findMany({
      where: { userId, carteira },
      orderBy: { anoMes: 'asc' },
    });
  }
}
