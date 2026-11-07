import { FiscalService, vencimentoDarf } from './fiscal.service';

type Op = {
  data: string;
  ticker: string;
  assetType?: 'acao' | 'fii';
  tipo: 'compra' | 'venda';
  tradeType?: 'swing' | 'day_trade';
  quantidade: number;
  precoUnitario: number;
  custos?: number;
  irrfRetido?: number | null;
};

function servicoCom(ops: Op[]): FiscalService {
  const registros = ops.map((o, i) => ({
    id: String(i),
    userId: 'u',
    assetType: 'acao',
    tradeType: 'swing',
    custos: 0,
    irrfRetido: null,
    ...o,
    data: new Date(`${o.data}T12:00:00Z`),
    createdAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)),
    updatedAt: new Date(),
  }));
  const prisma = { operacaoFiscal: { findMany: jest.fn().mockResolvedValue(registros) } };
  return new FiscalService(prisma as never);
}

const darf = (r: Awaited<ReturnType<FiscalService['getApuracaoAnual']>>, anoMes: string) => r.darfs.find((d) => d.anoMes === anoMes)!;

describe('FiscalService.getApuracaoAnual — DARF', () => {
  it('ganho isento não consome prejuízo acumulado', async () => {
    const r = await servicoCom([
      { data: '2026-01-05', ticker: 'AAAA3', tipo: 'compra', quantidade: 100, precoUnitario: 20 },
      { data: '2026-01-10', ticker: 'AAAA3', tipo: 'venda', quantidade: 100, precoUnitario: 10, irrfRetido: 0 }, // -1000
      { data: '2026-02-05', ticker: 'BBBB3', tipo: 'compra', quantidade: 100, precoUnitario: 10 },
      { data: '2026-02-10', ticker: 'BBBB3', tipo: 'venda', quantidade: 100, precoUnitario: 18, irrfRetido: 0 }, // +800 isento
      { data: '2026-03-05', ticker: 'CCCC3', tipo: 'compra', quantidade: 1000, precoUnitario: 20 },
      { data: '2026-03-10', ticker: 'CCCC3', tipo: 'venda', quantidade: 1000, precoUnitario: 25, irrfRetido: 0 }, // +5000, vendas 25k
    ]).getApuracaoAnual('u', 2026);

    const fev = r.meses.find((m) => m.anoMes === '2026-02' && m.bucket === 'comum')!;
    expect(fev.isento).toBe(true);
    expect(fev.prejuizoCompensado).toBe(0);
    expect(fev.prejuizoAcumuladoFinal).toBe(1000);

    const mar = r.meses.find((m) => m.anoMes === '2026-03' && m.bucket === 'comum')!;
    expect(mar.prejuizoCompensado).toBe(1000);
    expect(mar.baseTributavel).toBe(4000);
    expect(mar.impostoDevido).toBe(600);
    expect(darf(r, '2026-03')).toMatchObject({ valorDarf: 600, pagar: true, codigoReceita: '6015', vencimento: '2026-04-30' });
  });

  it('abate IRRF estimado (0,005%) e acumula DARF < R$ 10 pro mês seguinte', async () => {
    const r = await servicoCom([
      { data: '2026-01-05', ticker: 'XPML11', assetType: 'fii', tipo: 'compra', quantidade: 100, precoUnitario: 100 },
      { data: '2026-01-10', ticker: 'XPML11', assetType: 'fii', tipo: 'venda', quantidade: 10, precoUnitario: 120 }, // +200 → 40
      { data: '2026-02-10', ticker: 'XPML11', assetType: 'fii', tipo: 'venda', quantidade: 10, precoUnitario: 102 }, // +20 → 4
      { data: '2026-03-10', ticker: 'XPML11', assetType: 'fii', tipo: 'venda', quantidade: 10, precoUnitario: 125 }, // +250 → 50
    ]).getApuracaoAnual('u', 2026);

    // IRRF estimado de R$ 0,06 no mês: abaixo de R$ 1, a corretora não retém.
    expect(darf(r, '2026-01')).toMatchObject({ impostoDevido: 40, irrfDoMes: 0, valorDarf: 40, pagar: true });
    expect(darf(r, '2026-02')).toMatchObject({ impostoDevido: 4, valorDarf: 4, pagar: false });
    expect(darf(r, '2026-03')).toMatchObject({ valorAcumuladoAnterior: 4, valorDarf: 54, pagar: true });
    expect(r.totalDarfAno).toBe(94);
  });

  it('day trade a 20% com IRRF informado; saldo de IRRF não usado vai pro mês seguinte', async () => {
    const r = await servicoCom([
      { data: '2026-05-04', ticker: 'PETR4', tipo: 'compra', tradeType: 'day_trade', quantidade: 100, precoUnitario: 30 },
      { data: '2026-05-04', ticker: 'PETR4', tipo: 'venda', tradeType: 'day_trade', quantidade: 100, precoUnitario: 29, irrfRetido: 5 }, // -100
      { data: '2026-06-01', ticker: 'PETR4', tipo: 'compra', tradeType: 'day_trade', quantidade: 100, precoUnitario: 30 },
      { data: '2026-06-01', ticker: 'PETR4', tipo: 'venda', tradeType: 'day_trade', quantidade: 100, precoUnitario: 33 }, // +300 → base 200
    ]).getApuracaoAnual('u', 2026);

    expect(darf(r, '2026-05')).toMatchObject({ impostoDevido: 0, irrfSaldoFinal: 5 });
    // jun: imposto 40; IRRF estimado 1% de 300 = 3 + saldo 5 = 8 → DARF 32
    expect(darf(r, '2026-06')).toMatchObject({ impostoDevido: 40, irrfDisponivel: 8, irrfCompensado: 8, valorDarf: 32, irrfEstimado: true });
  });

  it('prejuízo e DARF acumulado atravessam o ano', async () => {
    const r = await servicoCom([
      { data: '2025-12-01', ticker: 'HGLG11', assetType: 'fii', tipo: 'compra', quantidade: 100, precoUnitario: 100 },
      { data: '2025-12-10', ticker: 'HGLG11', assetType: 'fii', tipo: 'venda', quantidade: 50, precoUnitario: 90 }, // -500
      { data: '2026-01-10', ticker: 'HGLG11', assetType: 'fii', tipo: 'venda', quantidade: 50, precoUnitario: 120 }, // +1000 → base 500
    ]).getApuracaoAnual('u', 2026);
    expect(darf(r, '2026-01')).toMatchObject({ impostoDevido: 100, valorDarf: 100 });
  });
});

describe('vencimentoDarf', () => {
  it('último dia útil do mês seguinte', () => {
    expect(vencimentoDarf('2026-10')).toBe('2026-11-30'); // segunda
    expect(vencimentoDarf('2026-04')).toBe('2026-05-29'); // 31/05 domingo
    expect(vencimentoDarf('2026-11')).toBe('2026-12-30'); // 31/12 sem expediente
    expect(vencimentoDarf('2026-12')).toBe('2027-01-29'); // 31/01/2027 domingo
  });
});
