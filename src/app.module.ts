import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiModule } from './ai/ai.module';
import { ToolModule } from './tool/tool.module';

@Module({
  imports: [AiModule, ToolModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
