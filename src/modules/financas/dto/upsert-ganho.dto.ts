import { IsBoolean, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpsertGanhoDto {
  @IsString()
  @MinLength(1)
  nome: string;

  @IsNumber()
  @Min(0)
  valor: number;

  @IsOptional()
  @IsBoolean()
  recebido?: boolean;
}
