import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.js';
import { MembershipController } from './membership.controller.js';
import { MembershipService } from './membership.service.js';
import { StoreBillingService } from './store-billing.js';

@Module({
  imports: [AuthModule],
  controllers: [MembershipController],
  providers: [MembershipService, StoreBillingService],
  exports: [MembershipService, StoreBillingService],
})
export class MembershipModule {}
