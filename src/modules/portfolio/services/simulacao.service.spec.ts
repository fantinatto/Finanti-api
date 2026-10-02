import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { InvestimentoService } from './investimento.service';
import { SimulacaoService } from './simulacao.service';

describe('SimulacaoService.executarCompraDoMotor', () => {
  const userId = 'user-1';
  const ticker = 'ABCD3';
  const anoMes = '2026-09';
  let service: SimulacaoService;
  let tx: any;
  let prisma: any;

  beforeEach(() => {
    tx = {
      simulacaoConfig: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      investimento: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'investment-1' }),
      },
      transacaoSimulacao: {
        create: jest.fn().mockResolvedValue({ quantidade: 2, preco: 100, valor: 200 }),
      },
    };
    prisma = {
      indicadorMensal: { findUnique: jest.fn().mockResolvedValue({ precoFechamento: 100 }) },
      portfolioConfig: { findUnique: jest.fn().mockResolvedValue({ permiteFracionario: true }) },
      $transaction: jest.fn((callback: (client: any) => Promise<unknown>) => callback(tx)),
    };
    service = new SimulacaoService(prisma as PrismaService, {} as InvestimentoService);
  });

  it('rejeita a compra quando não existe caixa disponível', async () => {
    tx.simulacaoConfig.findUnique.mockResolvedValue(null);

    await expect(service.executarCompraDoMotor(userId, ticker, 250, anoMes)).rejects.toThrow(
      new BadRequestException('Não há caixa disponível pra executar essa compra.'),
    );
    expect(tx.investimento.create).not.toHaveBeenCalled();
  });

  it('debita o custo efetivo e mantém no caixa a sobra do arredondamento', async () => {
    tx.simulacaoConfig.findUnique.mockResolvedValue({ caixaDisponivel: 300 });

    const resultado = await service.executarCompraDoMotor(userId, ticker, 250, anoMes);

    expect(tx.simulacaoConfig.updateMany).toHaveBeenCalledWith({
      where: { userId, caixaDisponivel: { gte: 200 } },
      data: { caixaDisponivel: { decrement: 200 } },
    });
    expect(resultado.sobra).toBe(50);
    expect(tx.simulacaoConfig.upsert).toBeUndefined();
  });

  it('aborta a compra se o saldo ficar insuficiente antes do débito atômico', async () => {
    tx.simulacaoConfig.findUnique.mockResolvedValue({ caixaDisponivel: 300 });
    tx.simulacaoConfig.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.executarCompraDoMotor(userId, ticker, 250, anoMes)).rejects.toThrow(
      new BadRequestException('Caixa disponível insuficiente para executar essa compra.'),
    );
  });
});