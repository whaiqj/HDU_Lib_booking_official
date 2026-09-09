import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GrabSeatWorker } from './grab-seat-worker.service';
import { SeatSelectionStrategy } from './strategies/seat-selection.strategy';
import { SeatPreparseService } from './seat-preparse.service';
import { SeatMappingCacheService } from './seat-mapping-cache.service';
import { SeatMappingCache } from './entities/seat-mapping-cache.entity';
import { UserInfoCache } from './entities/user-info-cache.entity';
import { HduLibraryModule } from '../hdu-library/hdu-library.module';
import { GrabTaskModule } from '../grab-task/grab-task.module';
import { SessionModule } from '../session/session.module';
import { NotificationModule } from '../notification/notification.module';
import { GrabAttemptLogModule } from '../grab-attempt-log/grab-attempt-log.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SeatMappingCache, UserInfoCache]),
    HduLibraryModule,
    GrabTaskModule,
    SessionModule,
    NotificationModule,
    GrabAttemptLogModule,
  ],
  providers: [
    GrabSeatWorker,
    SeatSelectionStrategy,
    SeatPreparseService,
    SeatMappingCacheService,
  ],
  exports: [GrabSeatWorker, SeatPreparseService],
})
export class GrabSeatModule {}
