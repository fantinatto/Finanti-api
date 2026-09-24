export type IndicatorDirection = 'higher_better' | 'lower_better';
export type ScoreGroup = 'qualidade' | 'risco' | 'preco';

export interface IndicatorConfig {
  field: string;
  direction: IndicatorDirection;
  scoreGroup: ScoreGroup;
  /**
   * Exclui o valor da própria ação do score dela quando negativo (normalizarIndicador) —
   * o indicador vira "ausente" em vez de penalizar ou premiar. NÃO afeta o cálculo da
   * mediana do grupo (calcularMedias sempre usa todos os valores, negativos inclusive,
   * pra não inflar artificialmente a régua do setor). Fica sem efeito nos campos que também
   * têm penalizeNonPositive: true, porque esse último tem prioridade.
   */
  excludeNegativeFromAvg: boolean;
  /** Valor negativo é sinal positivo (ex: DL/PL < 0 = caixa líquido) */
  negativeIsGood: boolean;
  /**
   * Valor negativo (ou <= 0 em lower_better) é sinal ruim e recebe a nota mínima
   * (NORM_CLAMP_MIN) em vez de ser excluído do score da ação — não é "indicador ausente",
   * é a empresa destruindo valor nesse eixo (ex: P/L <= 0 = prejuízo, ROE < 0 = queimando
   * caixa). Funciona pros dois direction (checado antes do cálculo de norm em ambos).
   */
  penalizeNonPositive: boolean;
}

export const INDICATOR_CONFIG: IndicatorConfig[] = [
  // Qualidade — ROE/ROIC negativos são a empresa destruindo valor, não "dado ausente":
  // sem penalizeNonPositive, uma empresa no prejuízo (ROE -15%) tinha o campo anulado e
  // podia terminar com scoreQualidade MAIOR que uma empresa com lucro modesto (ROE +1%),
  // já que essa última carrega a nota baixa real enquanto a primeira só usa os outros campos.
  { field: 'roe', direction: 'higher_better', scoreGroup: 'qualidade', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: true },
  { field: 'roic', direction: 'higher_better', scoreGroup: 'qualidade', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: true },
  { field: 'margemBruta', direction: 'higher_better', scoreGroup: 'qualidade', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: false },
  { field: 'margemLiquida', direction: 'higher_better', scoreGroup: 'qualidade', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: false },
  { field: 'cagrReceita5a', direction: 'higher_better', scoreGroup: 'qualidade', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: false },
  { field: 'cagrLucro5a', direction: 'higher_better', scoreGroup: 'qualidade', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: false },

  // Risco
  { field: 'dividaLiquidaPatrimonio', direction: 'lower_better', scoreGroup: 'risco', excludeNegativeFromAvg: false, negativeIsGood: true, penalizeNonPositive: false },
  { field: 'dividaLiquidaEbitda', direction: 'lower_better', scoreGroup: 'risco', excludeNegativeFromAvg: false, negativeIsGood: true, penalizeNonPositive: false },

  // Preço — P/L, P/VP e P/EBIT <= 0 são sinal ruim (prejuízo / patrimônio líquido negativo),
  // não "indicador ausente": recebem a nota mínima em vez de serem excluídos do score.
  // excludeNegativeFromAvg: false aqui porque penalizeNonPositive já cobre o caso negativo.
  { field: 'pl', direction: 'lower_better', scoreGroup: 'preco', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: true },
  { field: 'pvp', direction: 'lower_better', scoreGroup: 'preco', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: true },
  { field: 'dy', direction: 'higher_better', scoreGroup: 'preco', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: false },
  { field: 'pEbit', direction: 'lower_better', scoreGroup: 'preco', excludeNegativeFromAvg: false, negativeIsGood: false, penalizeNonPositive: true },
];

export const SCORE_WEIGHTS: Record<ScoreGroup, number> = {
  qualidade: 0.40,
  risco: 0.40,
  preco: 0.20,
};

export const NORM_CLAMP_MIN = 0.1;
export const NORM_CLAMP_MAX = 3.0;
