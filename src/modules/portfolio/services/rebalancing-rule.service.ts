import { Injectable } from '@nestjs/common';
import { TAXA_NEUTRA_DI_REFERENCIA, SENSIBILIDADE_JUROS } from '../rebalancing.config';

@Injectable()
export class RebalancingRuleService {
  calcularIdade(birthDate: Date): number {
    const hoje = new Date();
    let idade = hoje.getFullYear() - birthDate.getFullYear();
    const aindaNaoFezAniversario =
      hoje.getMonth() < birthDate.getMonth() ||
      (hoje.getMonth() === birthDate.getMonth() && hoje.getDate() < birthDate.getDate());
    if (aindaNaoFezAniversario) idade--;
    return idade;
  }

  /** Regra genérica "BASE − idade" (cobre as regras dos 80/100/110/120) — resultado é o % sugerido em renda variável. */
  calcularSugestaoBase(idade: number, base: number): number {
    return this.clamp(base - idade);
  }

  /** Mesma regra, descontada pelo desvio do DI futuro em relação a uma taxa neutra de referência. */
  calcularSugestaoAjustadaPorJuros(idade: number, base: number, taxaDi: number): number {
    const bruto = base - idade - SENSIBILIDADE_JUROS * (taxaDi - TAXA_NEUTRA_DI_REFERENCIA);
    return this.clamp(bruto);
  }

  private clamp(valor: number): number {
    return Math.max(0, Math.min(100, valor));
  }
}
