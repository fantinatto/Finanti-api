import { IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

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
}
