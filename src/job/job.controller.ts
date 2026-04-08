import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { JobService } from './job.service';

@Controller('jobs')
export class JobController {
  constructor(private readonly jobService: JobService) {}

  @Get()
  async listJobs() {
    return this.jobService.listJobs();
  }

  @Post()
  async addJob(
    @Body()
    body: {
      type: 'cron' | 'every' | 'at';
      instruction: string;
      cron?: string;
      everyMs?: number;
      at?: string;
      isEnabled?: boolean;
    },
  ) {
    // 验证必填字段
    if (!body.type || !body.instruction) {
      throw new BadRequestException('type and instruction are required');
    }

    const input: any = {
      type: body.type,
      instruction: body.instruction,
      isEnabled: body.isEnabled ?? true,
    };

    if (body.type === 'cron') {
      if (!body.cron) {
        throw new BadRequestException(
          'cron expression is required for cron type',
        );
      }
      input.cron = body.cron;
    } else if (body.type === 'every') {
      if (!body.everyMs || body.everyMs <= 0) {
        throw new BadRequestException(
          'everyMs must be a positive number for every type',
        );
      }
      input.everyMs = body.everyMs;
    } else if (body.type === 'at') {
      if (!body.at) {
        throw new BadRequestException('at date is required for at type');
      }
      const date = new Date(body.at);
      if (isNaN(date.getTime())) {
        throw new BadRequestException('Invalid date format for at');
      }
      input.at = date;
    } else {
      throw new BadRequestException('Invalid job type');
    }

    return this.jobService.addJob(input);
  }

  @Post(':id/toggle')
  async toggleJob(
    @Param('id') id: string,
    @Body() body: { enabled?: boolean },
  ) {
    return this.jobService.toggleJob(id, body.enabled);
  }
}
