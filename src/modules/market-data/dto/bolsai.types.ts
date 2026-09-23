export interface BolsaiFundamentals {
  ticker: string;
  reference_date: string;
  pl: number | null;
  pvp: number | null;
  p_ebit: number | null;
  lpa: number | null;
  vpa: number | null;
  roe: number | null;
  roa: number | null;
  roic: number | null;
  net_margin: number | null;
  gross_margin: number | null;
  ebit_margin: number | null;
  net_debt_equity: number | null;
  net_debt_ebitda: number | null;
  cagr_revenue_5y: number | null;
  cagr_earnings_5y: number | null;
}
