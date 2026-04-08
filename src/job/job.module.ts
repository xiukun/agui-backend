import { forwardRef, Module } from '@nestjs/common';
import { JobService } from './job.service';
import { ToolModule } from 'src/tool/tool.module';
import { JobAgentService } from 'src/ai/job-agent.service';
import { MemoryModule } from '../memory/memory.module';
import { JobController } from './job.controller';

@Module({
  imports: [forwardRef(() => ToolModule), MemoryModule],
  controllers: [JobController],
  providers: [JobService, JobAgentService],
  exports: [JobService],
})
export class JobModule {}
