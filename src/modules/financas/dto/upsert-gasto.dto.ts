import { IsBoolean, IsDateString, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpsertGastoDto {
  @IsString()
  @MinLength(1)
  nome: string;

  @IsOptional()
  @IsString()
  formaPagamento?: string;

  @IsNumber()
  @Min(0)
  valor: number;

  @IsOptional()
  @IsBoolean()
  pago?: boolean;

  @IsOptional()
  @IsDateString()
  dataVencimento?: string;
}
