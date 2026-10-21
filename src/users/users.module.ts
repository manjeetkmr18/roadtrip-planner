import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.js';
import { MembershipModule } from '../membership/membership.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule, MembershipModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
