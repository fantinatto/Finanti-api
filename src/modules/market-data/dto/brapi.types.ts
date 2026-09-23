export interface BrapiListResponse {
  stocks: BrapiListItem[];
}

export interface BrapiListItem {
  stock: string;
  name: string;
  close: number;
  change: number;
  volume: number;
  market_cap: number | null;
  logo: string;
  sector: string | null;
}

export interface BrapiQuoteResponse {
  results: BrapiQuoteResult[];
  requestedAt: string;
  took: string;
}

export interface BrapiQuoteResult {
  symbol: string;
  shortName: string;
  longName: string | null;
  currency: string;
  marketCap: number | null;
  priceEarnings: number | null;
  earningsPerShare: number | null;
  summaryProfile?: BrapiSummaryProfile;
  defaultKeyStatistics?: BrapiDefaultKeyStatistics;
  financialData?: BrapiFinancialData;
}

export interface BrapiSummaryProfile {
  sector: string | null;
  industry: string | null;
  longBusinessSummary: string | null;
  country: string | null;
}

export interface BrapiDefaultKeyStatistics {
  returnOnEquity: number | null;
  bookValue: number | null;
  forwardEps: number | null;
  enterpriseValue: number | null;
  trailingEps: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
}

export interface BrapiFinancialData {
  currentPrice: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  debtToEquity: number | null;
  grossMargins: number | null;
  operatingMargins: number | null;
  profitMargins: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
}
