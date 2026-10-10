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

/**
 * Shape da Status Invest pra FII (`CategoryType=2`, endpoint `/fundos-imobiliarios/busca-avancada`)
 * — campos bem diferentes dos de ação, confirmado via chamada real em 2026-10-08.
 * `sectorname` aqui é o TIPO do fundo (Fundo de Tijolo/Papel/Misto/Fundo de Fundos), não um
 * setor econômico; `segment` é o segmento de atuação (Shoppings/Lajes Corporativas/Logística/
 * Papéis/etc — mesmo conceito da lista hoje hardcoded em AlocacaoSegmentoFii/carteira.component.ts).
 */
export interface StatusInvestFiiItem {
  ticker: string;
  companyname: string | null;
  price: number | null;
  sectorname: string | null;
  segment: string | null;
  gestao_f: string | null;
  dy: number | null;
  p_vp: number | null;
  valorpatrimonialcota: number | null;
  liquidezmediadiaria: number | null;
  percentualcaixa: number | null;
  dividend_cagr: number | null;
  cota_cagr: number | null;
  numerocotistas: number | null;
  numerocotas: number | null;
  patrimonio: number | null;
  lastdividend: number | null;
}

export interface StatusInvestFiiResponse {
  list: StatusInvestFiiItem[];
  totalResults: number;
}
