export interface StatusInvestItem {
  ticker: string;
  companyname: string | null;
  price: number | null;
  p_l: number | null;
  dy: number | null;
  p_vp: number | null;
  p_ebit: number | null;
  margembruta: number | null;
  margemebit: number | null;
  margemliquida: number | null;
  roe: number | null;
  roa: number | null;
  roic: number | null;
  dividaliquidapatrimonioliquido: number | null;
  dividaliquidaebit: number | null;
  receitas_cagr5: number | null;
  lucros_cagr5: number | null;
  vpa: number | null;
  lpa: number | null;
  valormercado: number | null;
  sectorname: string | null;
  segmentname: string | null;
  subsectorname: string | null;

  // Campos só usados como filtro avançado na tela de Coleta — não entram no score
  // (ver INDICATOR_CONFIG), só existem aqui pra permitir filtrar a ingestão por eles.
  peg_ratio: number | null;
  p_ativo: number | null;
  ev_ebit: number | null;
  p_sr: number | null;
  p_capitalgiro: number | null;
  p_ativocirculante: number | null;
  liquidezcorrente: number | null;
  pl_ativo: number | null;
  passivo_ativo: number | null;
  giroativos: number | null;
  liquidezmediadiaria: number | null;
}

export interface StatusInvestResponse {
  list: StatusInvestItem[];
  totalResults: number;
}
