import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.js';
import { MembershipController } from './membership.controller.js';
import { MembershipService } from './membership.service.js';

@Module({
  imports: [AuthModule],
  controllers: [MembershipController],
  providers: [MembershipService],
  exports: [MembershipService],
})
export class MembershipModule {}
