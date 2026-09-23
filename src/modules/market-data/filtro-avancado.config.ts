import { StatusInvestItem } from './dto/statusinvest.types';

export interface FiltroAvancadoMeta {
  campo: keyof StatusInvestItem;
  label: string;
  grupo: 'valuation' | 'rentabilidade' | 'endividamento' | 'crescimento' | 'outros';
}

/**
 * Todo campo numérico de faixa que a busca avançada da Status Invest aceita (exceto
 * valormercado, que já tem o filtro dedicado marketCapMin). Única fonte de verdade tanto
 * pro filtro no backend (ingestion.service.ts) quanto pros labels exibidos na tela de Coleta.
 */
export const FILTROS_AVANCADOS_CONFIG: FiltroAvancadoMeta[] = [
  // Valuation
  { campo: 'p_l', label: 'P/L', grupo: 'valuation' },
  { campo: 'p_vp', label: 'P/VP', grupo: 'valuation' },
  { campo: 'p_ebit', label: 'P/EBIT', grupo: 'valuation' },
  { campo: 'ev_ebit', label: 'EV/EBIT', grupo: 'valuation' },
  { campo: 'p_sr', label: 'P/Receita (P/SR)', grupo: 'valuation' },
  { campo: 'p_ativo', label: 'P/Ativo', grupo: 'valuation' },
  { campo: 'p_capitalgiro', label: 'P/Capital de Giro', grupo: 'valuation' },
  { campo: 'p_ativocirculante', label: 'P/Ativo Circulante', grupo: 'valuation' },
  { campo: 'peg_ratio', label: 'PEG Ratio', grupo: 'valuation' },

  // Rentabilidade
  { campo: 'roe', label: 'ROE (%)', grupo: 'rentabilidade' },
  { campo: 'roic', label: 'ROIC (%)', grupo: 'rentabilidade' },
  { campo: 'roa', label: 'ROA (%)', grupo: 'rentabilidade' },
  { campo: 'margembruta', label: 'Margem Bruta (%)', grupo: 'rentabilidade' },
  { campo: 'margemebit', label: 'Margem EBIT (%)', grupo: 'rentabilidade' },
  { campo: 'margemliquida', label: 'Margem Líquida (%)', grupo: 'rentabilidade' },

  // Endividamento
  { campo: 'dividaliquidapatrimonioliquido', label: 'Dívida Líq./Patrimônio', grupo: 'endividamento' },
  { campo: 'dividaliquidaebit', label: 'Dívida Líq./EBIT', grupo: 'endividamento' },
  { campo: 'liquidezcorrente', label: 'Liquidez Corrente', grupo: 'endividamento' },
  { campo: 'pl_ativo', label: 'Patrimônio/Ativo', grupo: 'endividamento' },
  { campo: 'passivo_ativo', label: 'Passivo/Ativo', grupo: 'endividamento' },

  // Crescimento
  { campo: 'receitas_cagr5', label: 'CAGR Receita 5a (%)', grupo: 'crescimento' },
  { campo: 'lucros_cagr5', label: 'CAGR Lucro 5a (%)', grupo: 'crescimento' },

  // Outros
  { campo: 'dy', label: 'Dividend Yield (%)', grupo: 'outros' },
  { campo: 'giroativos', label: 'Giro de Ativos', grupo: 'outros' },
  { campo: 'liquidezmediadiaria', label: 'Liquidez Média Diária (R$)', grupo: 'outros' },
  { campo: 'vpa', label: 'VPA', grupo: 'outros' },
  { campo: 'lpa', label: 'LPA', grupo: 'outros' },
];

/** R$/dia — abaixo disso, poucos negócios distorcem P/L e P/VP e o papel provavelmente
 * está deslistado/incorporado/sem liquidez real. */
export const LIQUIDEZ_MEDIA_DIARIA_MINIMA = 500_000;

export interface FiltroFixoMeta {
  label: string;
  descricao: string;
}

/**
 * Filtros que a ingestão SEMPRE aplica, incondicionalmente — não são opcionais como
 * FILTROS_AVANCADOS_CONFIG. Existem só pra a tela de Coleta deixar isso visível (senão fica
 * escondido no código do backend e o usuário não sabe por que um ticker específico sumiu).
 */
export const FILTROS_FIXOS_CONFIG: FiltroFixoMeta[] = [
  {
    label: 'Preço > R$ 0',
    descricao: 'Papel precisa ter cotação ativa. Preço zerado/ausente = provavelmente deslistado ou incorporado.',
  },
  {
    label: `Liquidez Média Diária ≥ R$ ${LIQUIDEZ_MEDIA_DIARIA_MINIMA.toLocaleString('pt-BR')}`,
    descricao: 'Evita que papéis quase sem negociação (um único trade distorce P/L e P/VP) dominem o ranking.',
  },
];
