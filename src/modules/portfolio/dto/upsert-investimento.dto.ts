import { IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

const TIPOS_VALIDOS = ['acao', 'fii', 'renda_fixa'] as const;
export type TipoInvestimento = (typeof TIPOS_VALIDOS)[number];

export class UpsertInvestimentoDto {
  @IsIn(TIPOS_VALIDOS)
  tipo: TipoInvestimento;

  /** Ticker B3 — ausente pra renda fixa (não tem cotação de mercado). */
  @IsOptional()
  @IsString()
  ticker?: string;

  @IsString()
  @MinLength(1)
  nome: string;

  @IsNumber()
  @Min(0)
  precoMedio: number;

  @IsNumber()
  @Min(0)
  quantidade: number;

  /** Só lido na criação da carteira REAL (PortfolioController.criarInvestimento) — quando true,
   * espelha esta compra como uma OperacaoFiscal ('compra'). Ignorado em edição (atualizar()) e
   * na Simulação, que não tem implicação fiscal. Ver docs/FEATURE_SPEC_FISCAL.md seção 2. */
  @IsOptional()
  @IsBoolean()
  registrarFiscal?: boolean;

  /** Data real da operação, pra registrarFiscal. Default: hoje (server). Deixar o usuário mudar
   * pra ontem/mês passado é o que permite cadastrar uma compra atrasada sem sujar a data. */
  @IsOptional()
  @IsDateString()
  dataOperacao?: string;

  /** Corretagem/emolumentos da operação, pra registrarFiscal. Default 0. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  custosFiscais?: number;
}
