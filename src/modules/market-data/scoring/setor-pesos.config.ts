export interface SectorWeightConfig {
  qualidade: Record<string, number>;
  risco: Record<string, number>;
  preco: Record<string, number>;
}

/**
 * Peso de cada indicador dentro do próprio eixo — some 1.0 (100%) por eixo. Diferente de
 * INDICATOR_CONFIG (que define QUAIS campos existem, direção e regras de negativo), esta
 * tabela define QUANTO cada campo pesa, e isso varia por segmento/setor: o que move Bancos
 * (ROE, margem) não é o que move uma elétrica (dívida tolerável maior, DY relevante).
 *
 * Chave de lookup: primeiro tenta pelo `segmento` da ação (mais específico — evita zerar
 * ROIC/Dívida-EBITDA de seguradoras/corretoras junto com bancos, que têm setor igual mas
 * estrutura de balanço bem diferente), depois pelo `setor`, senão cai no DEFAULT.
 * Ver getPesosGrupo.
 */
export const SETOR_PESOS_CONFIG: Record<string, SectorWeightConfig> = {
  // Espelha as proporções do INDICATOR_CONFIG anterior (roe:roic:margemBruta:margemLiquida:
  // cagrReceita:cagrLucro = 3:3:2:2:2:1, dividaPL:dividaEbitda = 3:2, pl:pvp:dy:pEbit = 3:3:2:1),
  // arredondado pra números redondos — comportamento praticamente idêntico ao anterior pra
  // qualquer ação que não caia num override específico abaixo.
  DEFAULT: {
    qualidade: { roe: 0.25, roic: 0.25, margemBruta: 0.15, margemLiquida: 0.15, cagrReceita5a: 0.10, cagrLucro5a: 0.10 },
    risco: { dividaLiquidaPatrimonio: 0.60, dividaLiquidaEbitda: 0.40 },
    preco: { pl: 0.35, pvp: 0.35, dy: 0.20, pEbit: 0.10 },
  },

  // Segmento (não o setor "Financeiro e Outros" inteiro, que também tem seguradoras e
  // corretoras): ROIC e Dívida Líq./EBITDA não fazem sentido pro negócio de captar/emprestar
  // — peso 0 explícito em vez do hack de nulificar o indicador na ingestão.
  Bancos: {
    qualidade: { roe: 0.50, roic: 0.00, margemBruta: 0.00, margemLiquida: 0.30, cagrReceita5a: 0.10, cagrLucro5a: 0.10 },
    risco: { dividaLiquidaPatrimonio: 1.00, dividaLiquidaEbitda: 0.00 },
    preco: { pl: 0.45, pvp: 0.45, dy: 0.10, pEbit: 0.00 },
  },

  // Setor: alta previsibilidade de caixa tolera mais dívida (peso maior em Dívida/EBITDA,
  // métrica mais usada nesse setor que Dívida/Patrimônio) e DY é o motivo de a maioria
  // comprar o papel, então ganha peso bem maior em Preço.
  'Utilidade Pública': {
    qualidade: { roe: 0.30, roic: 0.30, margemBruta: 0.10, margemLiquida: 0.10, cagrReceita5a: 0.10, cagrLucro5a: 0.10 },
    risco: { dividaLiquidaPatrimonio: 0.30, dividaLiquidaEbitda: 0.70 },
    preco: { pl: 0.25, pvp: 0.25, dy: 0.40, pEbit: 0.10 },
  },

  // Setor: Varejo/Vestuário/Construtoras/Automotivo — exposto a ciclo macro (juros, inflação,
  // renda disponível), depende de giro de capital de giro eficiente. ROIC mede rentabilização
  // do capital mesmo em juros altos; DY pesa menos porque reter caixa pra giro costuma ser
  // prioridade frente a distribuir dividendo.
  'Consumo Cíclico': {
    qualidade: { roic: 0.30, margemLiquida: 0.25, roe: 0.20, cagrReceita5a: 0.15, cagrLucro5a: 0.10, margemBruta: 0.00 },
    risco: { dividaLiquidaEbitda: 0.60, dividaLiquidaPatrimonio: 0.40 },
    preco: { pl: 0.35, pvp: 0.30, pEbit: 0.20, dy: 0.15 },
  },

  // Setor: Máquinas/Equipamentos/Logística/Bens de Capital — capital intensivo, ciclos de
  // produção longos, ativos financiados via dívida de longo prazo (por isso Dívida/EBITDA
  // pesa mais que em outros setores). P/EBIT pesa mais que P/L em Preço porque isola o
  // resultado operacional de estrutura financeira/fiscal, mais limpo pra comparar indústrias.
  'Bens Industriais': {
    qualidade: { roic: 0.35, margemBruta: 0.20, margemLiquida: 0.15, cagrLucro5a: 0.15, cagrReceita5a: 0.10, roe: 0.05 },
    risco: { dividaLiquidaEbitda: 0.70, dividaLiquidaPatrimonio: 0.30 },
    preco: { pEbit: 0.35, pl: 0.30, pvp: 0.20, dy: 0.15 },
  },
};

/**
 * Cobre DEFAULT, Bancos, Utilidade Pública, Consumo Cíclico e Bens Industriais — os demais
 * setores da B3 (Tecnologia, Saúde, Materiais Básicos, Petróleo/Gás etc.) caem no DEFAULT
 * por ora. Adicionar mais overrides precisa de pesos definidos com critério de investimento,
 * não um número inventado — fica pra quando isso for definido explicitamente.
 */
export function getPesosGrupo(setor: string | null, segmento: string | null): SectorWeightConfig {
  if (segmento && SETOR_PESOS_CONFIG[segmento]) return SETOR_PESOS_CONFIG[segmento];
  if (setor && SETOR_PESOS_CONFIG[setor]) return SETOR_PESOS_CONFIG[setor];
  return SETOR_PESOS_CONFIG.DEFAULT;
}
