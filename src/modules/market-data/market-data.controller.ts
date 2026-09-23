import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IngestionService } from './services/ingestion.service';
import { RankingQueryService } from './services/ranking-query.service';
import { BrapiService } from './services/brapi.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IngestionFiltroDto } from './dto/ingestion-filtro.dto';
import { FILTROS_AVANCADOS_CONFIG, FILTROS_FIXOS_CONFIG } from './filtro-avancado.config';

@Controller('market-data')
@UseGuards(JwtAuthGuard)
export class MarketDataController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly ranking: RankingQueryService,
    private readonly brapi: BrapiService,
  ) {}

  @Post('ingest')
  async ingerir(@Body() filtro: IngestionFiltroDto = {}) {
    return this.ingestion.executar(filtro);
  }

  @Get('filtros-avancados')
  getFiltrosAvancados() {
    return FILTROS_AVANCADOS_CONFIG;
  }

  @Get('filtros-fixos')
  getFiltrosFixos() {
    return FILTROS_FIXOS_CONFIG;
  }

  @Get('meses')
  async getMeses() {
    return this.ranking.getMeses();
  }

  @Get('grupos')
  async getGrupos(
    @Query('tipoGrupo') tipoGrupo: string,
    @Query('anoMes') anoMes: string,
  ) {
    return this.ranking.getGrupos(tipoGrupo, anoMes);
  }

  @Get('indicadores')
  async getIndicadores(@Query('anoMes') anoMes: string) {
    return this.ranking.getIndicadores(anoMes);
  }

  @Get('resumo')
  async getResumo(@Query('anoMes') anoMes: string) {
    return this.ranking.getResumoColeta(anoMes);
  }

  @Get('preview/:ticker')
  async previewTicker(@Param('ticker') ticker: string) {
    return this.brapi.previewTicker(ticker.toUpperCase());
  }

  @Get('ranking')
  async getRanking(
    @Query('tipoGrupo') tipoGrupo: string,
    @Query('nomeGrupo') nomeGrupo: string,
    @Query('anoMes') anoMes: string,
  ) {
    return this.ranking.getRanking(tipoGrupo, nomeGrupo, anoMes);
  }

  @Get('ranking-hibrido')
  async getRankingHibrido(@Query('anoMes') anoMes: string) {
    return this.ranking.getRankingHibrido(anoMes);
  }

  @Get('medianas')
  async getMedianas(
    @Query('tipoGrupo') tipoGrupo: string,
    @Query('anoMes') anoMes: string,
  ) {
    return this.ranking.getMedianas(tipoGrupo, anoMes);
  }

  @Get('medianas-historico')
  async getMedianasHistorico(
    @Query('tipoGrupo') tipoGrupo: string,
    @Query('nomeGrupo') nomeGrupo: string,
  ) {
    return this.ranking.getMedianasHistorico(tipoGrupo, nomeGrupo);
  }

  @Get('top3')
  async getTop3(
    @Query('tipoGrupo') tipoGrupo: string,
    @Query('anoMes') anoMes: string,
  ) {
    return this.ranking.getTop3PorGrupo(tipoGrupo, anoMes);
  }

  @Get('historico-ranking')
  async getHistoricoRanking(@Query('tipoGrupo') tipoGrupo: string) {
    return this.ranking.getHistoricoTop3PorGrupo(tipoGrupo);
  }

  @Get('setores-por-segmento')
  async getSetoresPorSegmento() {
    return this.ranking.getMapaSetorSegmento();
  }
}
