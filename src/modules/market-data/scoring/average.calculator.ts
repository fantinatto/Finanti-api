import { IndicatorConfig } from './indicator.config';

export type IndicadoresMap = Record<string, number | null | undefined>;

export function calcularMedias(
  acoes: IndicadoresMap[],
  config: IndicatorConfig[],
): IndicadoresMap {
  const medias: IndicadoresMap = {};

  for (const indicator of config) {
    const valores: number[] = [];

    // Negativos entram na mediana do grupo (mesmo pra pl/pvp/roe/etc) — excluí-los infla
    // artificialmente a régua do setor (a mediana passaria a refletir só as empresas
    // lucrativas), o que penaliza injustamente quem está marginalmente lucrativo na
    // normalização (valor / mediana). excludeNegativeFromAvg continua valendo só pra
    // decidir o score da própria ação em normalizarIndicador, não pra esse cálculo.
    for (const acao of acoes) {
      const val = acao[indicator.field] as number | null | undefined;
      if (val === null || val === undefined || isNaN(val)) continue;
      valores.push(val);
    }

    medias[indicator.field] = valores.length > 0 ? mediana(valores) : null;
  }

  return medias;
}

/** Mediana em vez de média aritmética — mais robusta a outliers na normalização por grupo. */
function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 !== 0
    ? ordenados[meio]
    : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

export interface EstatisticaCampo {
  media: number;
  desvioPadrao: number;
}

/**
 * Média + desvio-padrão amostral (n-1) por campo — usado só pelo riscoDelta (Z-score real
 * pareia com média/desvio, não com mediana). Fica null se sobrarem menos de 2 valores ou se
 * desvioPadrao == 0 (Z indefinido — grupo inteiro com o mesmo valor).
 */
export function calcularMediaEDesvio(
  acoes: IndicadoresMap[],
  campos: string[],
): Record<string, EstatisticaCampo | null> {
  const resultado: Record<string, EstatisticaCampo | null> = {};

  for (const campo of campos) {
    const valores: number[] = [];
    for (const acao of acoes) {
      const val = acao[campo] as number | null | undefined;
      if (val === null || val === undefined || isNaN(val)) continue;
      valores.push(val);
    }

    if (valores.length < 2) {
      resultado[campo] = null;
      continue;
    }

    const media = valores.reduce((acc, v) => acc + v, 0) / valores.length;
    const variancia = valores.reduce((acc, v) => acc + (v - media) ** 2, 0) / (valores.length - 1);
    const desvioPadrao = Math.sqrt(variancia);

    resultado[campo] = desvioPadrao > 0 ? { media, desvioPadrao } : null;
  }

  return resultado;
}
