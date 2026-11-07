import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FiscalController } from './fiscal.controller';
import { FiscalService } from './services/fiscal.service';
import { BensDireitosService } from './services/bens-direitos.service';

@Module({
  imports: [AuthModule],
  controllers: [FiscalController],
  providers: [FiscalService, BensDireitosService],
  exports: [FiscalService],
})
export class FiscalModule {}
