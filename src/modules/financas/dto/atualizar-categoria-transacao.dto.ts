import { IsOptional, IsString } from 'class-validator';

export class AtualizarCategoriaTransacaoDto {
  @IsOptional()
  @IsString()
  categoria?: string;
}
