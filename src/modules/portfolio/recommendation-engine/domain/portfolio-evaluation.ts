import { BalanceamentoSetor, SaudeCarteira } from '../../services/investimento.service';

/** Cada eixo Δ carrega quanto do patrimônio ele realmente cobre (ajuste 9 do plano) — Δ pode ser
 * `null` pra alguns tickers (bancos sem dividaLiquidaEbitda, por exemplo), e uma média que só
 * ignora esses tickers muda de composição conforme quem tem dado disponível, não conforme
 * mudança real de risco/qualidade/preço. O comparador (Fase B2) usa `coverage` pra não
 * recompensar uma "melhora" que na verdade é só perda de cobertura. */
export interface SearchHealthAxis {
  /** Média ponderada do Δ — null se coverage=0 (nenhum ticker do universo avaliado tem esse Δ). */
  value: number | null;
  /** 0–1: fração do valorTotalAcoes cujo ticker TEM esse Δ calculado. */
  coverage: number;
}

export interface PortfolioHealthState {
  /** EXATAMENTE a matemática que getSaudeCarteira já expõe hoje (scoreQualidade/scorePreco
   * clássicos, riscoComposto) — bit-a-bit igual ao endpoint público. Nenhuma mudança de fórmula
   * aqui (ver plano, ajuste 1). */
  displayed: SaudeCarteira;
  /** Cálculo NOVO e adicional, só pro engine — os 3 eixos em Δ (qualidadeDelta/riscoDelta/
   * precoDelta), nunca exposto em endpoint/tela existente. */
  search: {
    quality: SearchHealthAxis;
    risk: SearchHealthAxis;
    price: SearchHealthAxis;
  };
  /** Avisos informativos quando coverage<0.8 num eixo — não bloqueia nada, só torna auditável. */
  lowCoverageWarnings: string[];
}

export interface PortfolioBalanceState {
  setores: BalanceamentoSetor[];
  sectorsOutsideBand: number;
  totalSectorDeviation: number;
  overweightSectors: BalanceamentoSetor[];
  underweightSectors: BalanceamentoSetor[];
  /** Sempre vazio nesta fase — não existe limite de concentração no schema ainda (ver plano,
   * Fase E). Não inventar limite; documentado como gap. */
  positionConcentrationViolations: never[];
  /** Sempre vazio nesta fase, mesmo motivo. */
  hardViolations: never[];
}

export interface PortfolioEvaluation {
  health: PortfolioHealthState;
  balance: PortfolioBalanceState;
}
