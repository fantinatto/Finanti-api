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
  /** Bit-a-bit igual a `getBalanceamentoPorSetor` hoje (denominador VIVO — soma das posições
   * atuais). Consumido por B1/wrappers legados. NÃO usar isso pro comparador (Fase B2+) — ver
   * `stableSetores`/os agregados abaixo. */
  setores: BalanceamentoSetor[];
  /**
   * Visão paralela usando `PortfolioState.searchAllocationBase` (estável dentro de uma mesma
   * linha de busca) em vez do denominador vivo — sem isso, vender uma posição sem recompra
   * imediata encolheria `valorTotalAcoes` e faria TODOS os outros setores parecerem mais
   * alocados só porque o denominador caiu, não porque mudou algo neles. `sectorsOutsideBand`/
   * `totalSectorDeviation`/`overweightSectors`/`underweightSectors` abaixo vêm DAQUI, não de
   * `setores` — são agregados novos (não existiam no `BalanceamentoSetor[]` legado, então
   * redefini-los pra usar a base estável não quebra nenhuma validação da Fase A.
   */
  stableSetores: BalanceamentoSetor[];
  /** Caixa/proceeds ainda não realocados — não deve ser tratado como estado terminal perfeito só
   * porque "resolveu" um setor por venda (ver invariante 1). */
  unallocatedCapital: number;
  unallocatedCapitalPercent: number;
  sectorsOutsideBand: number;
  totalSectorDeviation: number;
  overweightSectors: BalanceamentoSetor[];
  underweightSectors: BalanceamentoSetor[];
  /** Maior `maxSegmentShare` entre os setores com `concentrado=true` (ver
   * `PortfolioState.segmentConcentration`) — 0 se nenhum setor concentrado. Medida GLOBAL (como
   * `totalSectorDeviation`), não por setor: comparar dois candidatos que tocam setores diferentes
   * ainda faz sentido perguntando "qual deixa o PIOR problema de concentração da carteira
   * inteira melhor" (Fase C.1). */
  worstSegmentConcentration: number;
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
