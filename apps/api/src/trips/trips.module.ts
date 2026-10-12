import { DynamicModule, Injectable, Logger, Module } from '@nestjs/common';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import type { Job, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AuthModule } from '../auth/auth.js';
import { ShareController, TripsController } from './trips.controller.js';
import { GENERATION_QUEUE, GenerationQueue, TripsService } from './trips.service.js';

@Injectable()
class BullGenerationQueue extends GenerationQueue {
  constructor(@InjectQueue(GENERATION_QUEUE) private readonly queue: Queue) {
    super();
  }
  async enqueue(tripId: string) {
    await this.queue.add('generate', { tripId }, { jobId: `${tripId}-${Date.now()}`, attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 500, removeOnFail: 500 });
  }
}

@Processor(GENERATION_QUEUE, { concurrency: 3 })
class GenerationWorker extends WorkerHost {
  constructor(private readonly trips: TripsService) {
    super();
  }
  async process(job: Job<{ tripId: string }>) {
    await this.trips.runGeneration(job.data.tripId);
  }
}

/** Runs generation in the API process. For local development and tests only. */
@Injectable()
class InlineGenerationQueue extends GenerationQueue {
  private readonly log = new Logger('InlineQueue');
  constructor(private readonly moduleRef: ModuleRef) {
    super();
  }
  async enqueue(tripId: string) {
    const trips = this.moduleRef.get(TripsService, { strict: false });
    setImmediate(() => trips.runGeneration(tripId).catch((e) => this.log.error(e)));
  }
}

@Module({})
export class TripsModule {
  static register(opts: { inline: boolean; redisUrl: string }): DynamicModule {
    const queueImports = opts.inline
      ? []
      : [
          BullModule.forRoot({ connection: new Redis(opts.redisUrl, { maxRetriesPerRequest: null }) }),
          BullModule.registerQueue({ name: GENERATION_QUEUE }),
        ];
    return {
      module: TripsModule,
      imports: [AuthModule, ...queueImports],
      controllers: [TripsController, ShareController],
      providers: [
        TripsService,
        opts.inline ? { provide: GenerationQueue, useClass: InlineGenerationQueue } : { provide: GenerationQueue, useClass: BullGenerationQueue },
        ...(opts.inline ? [] : [GenerationWorker]),
      ],
      exports: [TripsService],
    };
  }
}
