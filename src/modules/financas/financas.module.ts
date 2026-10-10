import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FinancasController } from './financas.controller';
import { FinancasService } from './services/financas.service';

@Module({
  imports: [AuthModule],
  controllers: [FinancasController],
  providers: [FinancasService],
})
export class FinancasModule {}
