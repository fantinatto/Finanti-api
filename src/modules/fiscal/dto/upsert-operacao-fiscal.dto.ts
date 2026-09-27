import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

const ASSET_TYPES_VALIDOS = ['acao', 'fii'] as const;
export type AssetTypeFiscal = (typeof ASSET_TYPES_VALIDOS)[number];

const TIPOS_VALIDOS = ['compra', 'venda'] as const;
export type TipoOperacaoFiscal = (typeof TIPOS_VALIDOS)[number];

const TRADE_TYPES_VALIDOS = ['swing', 'day_trade'] as const;
export type TradeTypeFiscal = (typeof TRADE_TYPES_VALIDOS)[number];

export class UpsertOperacaoFiscalDto {
  @IsDateString()
  data: string;

  @IsString()
  @MinLength(1)
  ticker: string;

  @IsIn(ASSET_TYPES_VALIDOS)
  assetType: AssetTypeFiscal;

  @IsIn(TIPOS_VALIDOS)
  tipo: TipoOperacaoFiscal;

  /** Default "swing" — usuário marca "day_trade" manualmente (sem detecção automática). */
  @IsOptional()
  @IsIn(TRADE_TYPES_VALIDOS)
  tradeType?: TradeTypeFiscal;

  @IsNumber()
  @Min(0.0001)
  quantidade: number;

  @IsNumber()
  @Min(0)
  precoUnitario: number;

  /** Corretagem + emolumentos + outros custos da operação. Default 0. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  custos?: number;
}
