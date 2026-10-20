import { Injectable } from '@nestjs/common';

export interface TransacaoExtraida {
  data: Date;
  descricao: string;
  valor: number;
}

// Casa "DD/MM/AA <descrição> <valor>,DD" opcionalmente seguido de um 2º valor (coluna US$ da
// fatura, quando a compra é internacional) — captura só o 1º valor (R$), que é o que importa.
const REGEX_LINHA = /^(\d{2}\/\d{2}\/\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})(?:\s+-?[\d.]+,\d{2})?$/;

// "Pagamento de fatura" é a baixa do que você já pagou — crédito, não gasto novo. Único caso
// que precisa de exclusão explícita por nome (sinal negativo sozinho não basta: estorno de
// assinatura cancelada, ex "AMAZON PRIME CANAIS -36,90", TAMBÉM é negativo e É uma transação
// real que deve entrar, só que reduzindo o total em vez de aumentar).
const DESCRICAO_IGNORADA = /^pagamento de fatura/i;

/**
 * Extrai os lançamentos de uma fatura de cartão em PDF (validado contra fatura real da XP,
 * 2026-10-15 — ver plano) — não assume nenhum banco específico além do layout
 * "DD/MM/AA Descrição valor[,US$]" por linha, que é como o texto fica depois de agrupado por
 * posição Y na página (cada linha física do PDF = 1 linha de texto, PDF.js devolve itens de
 * texto soltos com coordenadas, não "linhas" prontas). Se o layout de outro banco for diferente,
 * este regex pode não casar — nesse caso getTransacoesSemCasar ajuda a depurar com uma amostra
 * real, não adivinhação.
 */
@Injectable()
export class ImportacaoFaturaService {
  async extrairTransacoes(buffer: Buffer): Promise<TransacaoExtraida[]> {
    // pdfjs-dist é ESM-only — dynamic import funciona em CommonJS/Nest compilado, não dá pra
    // usar `import` estático aqui (o compilador do Nest gera require()).
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

    const resultado: TransacaoExtraida[] = [];

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();

      const linhasPorY = new Map<number, string[]>();
      for (const item of content.items as { str: string; transform: number[] }[]) {
        const y = Math.round(item.transform[5]);
        if (!linhasPorY.has(y)) linhasPorY.set(y, []);
        linhasPorY.get(y)!.push(item.str);
      }

      for (const y of [...linhasPorY.keys()].sort((a, b) => b - a)) {
        const texto = linhasPorY.get(y)!.join(' ').replace(/\s+/g, ' ').trim();
        if (!texto) continue;

        const match = texto.match(REGEX_LINHA);
        if (!match) continue;

        const [, dataStr, descricaoBruta, valorStr] = match;
        if (DESCRICAO_IGNORADA.test(descricaoBruta)) continue;

        resultado.push({
          data: this.parseData(dataStr),
          // "IOF Transacoes Exterior R$" — o "R$" fica preso na descrição porque, nessa linha
          // específica da fatura, o valor some pro lugar da coluna que normalmente é só "R$"
          // (sem a coluna US$ ao lado) — cosmético, mas limpa pra exibição.
          descricao: descricaoBruta.replace(/\s+R\$$/, '').trim(),
          valor: this.parseValor(valorStr),
        });
      }
    }

    return resultado;
  }

  private parseData(dataStr: string): Date {
    const [dia, mes, anoCurto] = dataStr.split('/').map(Number);
    return new Date(2000 + anoCurto, mes - 1, dia);
  }

  private parseValor(valorStr: string): number {
    // "1.235,34" -> 1235.34 ; "-36,90" -> -36.90
    return parseFloat(valorStr.replace(/\./g, '').replace(',', '.'));
  }
}
