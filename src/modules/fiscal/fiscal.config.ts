/**
 * Parâmetros da legislação usados pela apuração fiscal (renda variável, pessoa física).
 *
 * Centralizados aqui porque a legislação muda: ao revisar, confira contra a fonte oficial e
 * atualize `REVISADO_EM`. Fonte base: IN RFB 1.585/2015 (arts. 56–65) e Lei 11.033/2004
 * (IRRF "dedo-duro"). Revisar a cada ano-base — especialmente após a Lei 15.270/2025
 * (tributação de dividendos a partir de 2026), que não altera estes parâmetros, mas pode
 * vir acompanhada de novas INs.
 */
export const REVISADO_EM = '2026-11-07';

/** Código de receita do DARF de ganhos líquidos em bolsa (PF) — o mesmo pra comum, day trade e FII. */
export const CODIGO_DARF = '6015';

/** Alíquota sobre o ganho líquido tributável, por bucket. */
export const ALIQUOTAS = {
  comum: 0.15,
  day_trade: 0.2,
  fii_fiagro: 0.2,
} as const;

/** Ações em operações comuns até este total de vendas no mês: ganho isento (só bucket "comum"). */
export const LIMITE_ISENCAO_COMUM_MENSAL = 20_000;

/** DARF abaixo deste valor não é pago no mês: acumula pros meses seguintes até atingi-lo. */
export const VALOR_MINIMO_DARF = 10;

/** IRRF "dedo-duro" estimado quando a operação não informa o valor retido pela corretora. */
export const IRRF_ALIQUOTA_SWING_SOBRE_VENDA = 0.00005; // 0,005% do valor de venda (comum e FII)
export const IRRF_ALIQUOTA_DAY_TRADE_SOBRE_GANHO = 0.01; // 1% do ganho em day trade

/** Retenção de 0,005% igual ou inferior a R$ 1,00 no mês é dispensada (a corretora não retém). */
export const IRRF_SWING_DISPENSA_ATE = 1;

/**
 * Bens e Direitos (DIRPF): grupo/código por classe de ativo. Conferir no programa da DIRPF do
 * ano — a Receita reorganizou os grupos em 2023 (ações 03-01, FII 07-03) e pode mudar de novo.
 */
export const BENS_DIREITOS_CODIGOS = {
  acao: { grupo: '03', codigo: '01', descricao: 'Ações (inclusive as listadas em bolsa)' },
  fii: { grupo: '07', codigo: '03', descricao: 'Fundos de Investimento Imobiliário (FII)' },
} as const;
