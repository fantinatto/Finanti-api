import { BensDireitosService, classeDoTicker, cnpjValido, gerarDiscriminacao, posicoesAte } from './bens-direitos.service';

const op = (data: string, ticker: string, tipo: 'compra' | 'venda', quantidade: number, precoUnitario: number, extra: Partial<{ assetType: string; custos: number }> = {}) => ({
  data: new Date(`${data}T12:00:00Z`),
  ticker,
  tipo,
  quantidade,
  precoUnitario,
  assetType: extra.assetType ?? 'acao',
  custos: extra.custos ?? 0,
});

describe('posicoesAte', () => {
  it('separa a posição de 31/12 do ano anterior e do ano-base', () => {
    const ops = [
      op('2025-03-01', 'CMIG4', 'compra', 100, 10, { custos: 10 }), // custo médio 10,10
      op('2026-02-01', 'CMIG4', 'compra', 100, 12), // custo médio 11,05
      op('2026-06-01', 'CMIG4', 'venda', 50, 15),
    ];
    const ant = posicoesAte(ops, new Date(Date.UTC(2026, 0, 1))).get('CMIG4')!;
    const atu = posicoesAte(ops, new Date(Date.UTC(2027, 0, 1))).get('CMIG4')!;
    expect(ant.quantidade).toBe(100);
    expect(ant.custoMedio).toBeCloseTo(10.1);
    expect(atu.quantidade).toBe(150);
    expect(atu.custoMedio).toBeCloseTo(11.05);
  });

  it('zera custo médio quando a posição é vendida inteira', () => {
    const ops = [op('2026-01-01', 'X', 'compra', 10, 10), op('2026-02-01', 'X', 'venda', 10, 12), op('2026-03-01', 'X', 'compra', 10, 20)];
    expect(posicoesAte(ops, null).get('X')!.custoMedio).toBe(20);
  });
});

describe('classeDoTicker', () => {
  it.each([
    ['CMIG3', 'acao', 'ON'],
    ['PINE4', 'acao', 'PN'],
    ['USIM5', 'acao', 'PNA'],
    ['ELET6', 'acao', 'PNB'],
    ['BRBI11', 'acao', 'UNIT'],
    ['XPML11', 'fii', 'FII'],
    ['AAPL34', 'acao', 'OUTRO'],
  ] as const)('%s → %s', (t, tipo, esperado) => expect(classeDoTicker(t, tipo)).toBe(esperado));
});

describe('cnpjValido', () => {
  it('aceita CNPJ válido e rejeita inválido', () => {
    expect(cnpjValido('33000167000101')).toBe(true); // Petrobras
    expect(cnpjValido('33000167000102')).toBe(false);
    expect(cnpjValido('11111111111111')).toBe(false);
  });
});

describe('gerarDiscriminacao', () => {
  const pos = (quantidade: number, custoMedio: number) => ({ quantidade, custoMedio, custoTotal: quantidade * custoMedio });

  it('ação com dados completos', () => {
    const txt = gerarDiscriminacao(
      { ticker: 'PETR3', assetType: 'acao', classe: 'ON', atual: pos(100, 30), anterior: pos(0, 0), cnpj: '33000167000101', razaoSocial: 'PETROLEO BRASILEIRO S.A. - PETROBRAS', administrador: null, cnpjAdministrador: null },
      { corretoraNome: 'XP Investimentos CCTVM S/A', corretoraCnpj: '02332886000104' },
    );
    expect(txt).toBe(
      '100 ações ordinárias (ON) de PETROLEO BRASILEIRO S.A. - PETROBRAS (PETR3), CNPJ 33.000.167/0001-01. Custodiadas na corretora XP Investimentos CCTVM S/A, CNPJ 02.332.886/0001-04. Custo médio de aquisição: R$ 30,00 por ação.',
    );
  });

  it('FII sem cadastro usa marcadores', () => {
    const txt = gerarDiscriminacao(
      { ticker: 'XPML11', assetType: 'fii', classe: 'FII', atual: pos(10, 105.5), anterior: pos(0, 0), cnpj: null, razaoSocial: null, administrador: null, cnpjAdministrador: null },
      null,
    );
    expect(txt).toContain('10 cotas do fundo [RAZÃO SOCIAL] (XPML11), CNPJ do fundo [CNPJ], administrado por [ADMINISTRADOR]');
    expect(txt).toContain('[CORRETORA]');
    expect(txt).toContain('R$ 105,50 por cota');
  });
});

describe('BensDireitosService.getBensDireitos', () => {
  it('lista posições, totais e divergência com a carteira real', async () => {
    const ops = [op('2025-05-01', 'PINE4', 'compra', 100, 5), op('2026-04-01', 'XPML11', 'compra', 10, 100, { assetType: 'fii' })].map((o, i) => ({
      ...o,
      id: String(i),
      createdAt: new Date(),
    }));
    const prisma = {
      operacaoFiscal: { findMany: jest.fn().mockResolvedValue(ops) },
      ativoFiscal: { findMany: jest.fn().mockResolvedValue([]) },
      configFiscal: { findUnique: jest.fn().mockResolvedValue(null) },
      investimento: { findMany: jest.fn().mockResolvedValue([{ ticker: 'PINE4', quantidade: 300 }, { ticker: 'XPML11', quantidade: 10 }]) },
      acao: { findMany: jest.fn().mockResolvedValue([{ ticker: 'PINE4', nome: 'PINE' }]) },
      fii: { findMany: jest.fn().mockResolvedValue([]) },
      indicadorMensal: { findMany: jest.fn().mockResolvedValue([{ ticker: 'PINE4', anoMes: '2026-11', precoFechamento: 6 }]) },
      indicadorMensalFii: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const r = await new BensDireitosService(prisma as never).getBensDireitos('u', 2026);

    expect(r.itens.map((i) => i.ticker)).toEqual(['PINE4', 'XPML11']);
    const pine = r.itens[0];
    expect(pine.anterior.custoTotal).toBe(500);
    expect(pine.atual.custoTotal).toBe(500);
    expect(pine.valorMercado).toBe(600);
    expect(pine.razaoSocialSugerida).toBe(true);
    expect(r.itens[1]).toMatchObject({ grupo: '07', codigo: '03', anterior: { quantidade: 0 } });
    expect(r.totais).toEqual({ anterior: 500, atual: 1500, valorMercado: 600 });
    expect(r.divergencias).toEqual([{ ticker: 'PINE4', quantidadeLivro: 100, quantidadeCarteira: 300 }]);
  });
});
