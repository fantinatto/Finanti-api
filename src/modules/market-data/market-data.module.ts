import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MarketDataController } from './market-data.controller';
import { BrapiService } from './services/brapi.service';
import { BolsaiService } from './services/bolsai.service';
import { StatusInvestService } from './services/statusinvest.service';
import { IngestionService } from './services/ingestion.service';
import { IngestionFiiService } from './services/ingestion-fii.service';
import { FiiRankingService } from './services/fii-ranking.service';
import { RankingQueryService } from './services/ranking-query.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [HttpModule, AuthModule],
  controllers: [MarketDataController],
  providers: [BrapiService, BolsaiService, StatusInvestService, IngestionService, IngestionFiiService, FiiRankingService, RankingQueryService],
  exports: [BrapiService, RankingQueryService, FiiRankingService],
})
export class MarketDataModule {}
