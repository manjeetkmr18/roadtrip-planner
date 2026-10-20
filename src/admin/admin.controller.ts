import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AdminGuard } from './admin.guard.js';
import {
  AdminService,
  CreateGrantRequest,
  DeleteUserRequest,
  RevokeGrantRequest,
  UserListQuery,
} from './admin.service.js';

const uuid = z.uuid();

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('users')
  users(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.listUsers(query);
  }

  @Get('users/:userId')
  user(@Param('userId', new ZodPipe(uuid)) userId: string) {
    return this.admin.getUser(userId);
  }

  @Post('users/:userId/pro-grants')
  grantPro(
    @CurrentUser() actor: AuthUser,
    @Param('userId', new ZodPipe(uuid)) userId: string,
    @Body(new ZodPipe(CreateGrantRequest)) body: z.infer<typeof CreateGrantRequest>,
  ) {
    return this.admin.grantPro(actor, userId, body);
  }

  @Post('pro-grants/:grantId/revoke')
  revokePro(
    @CurrentUser() actor: AuthUser,
    @Param('grantId', new ZodPipe(uuid)) grantId: string,
    @Body(new ZodPipe(RevokeGrantRequest)) body: z.infer<typeof RevokeGrantRequest>,
  ) {
    return this.admin.revokePro(actor, grantId, body);
  }

  @Get('billing')
  billing(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.billing(query);
  }

  @Get('audit-logs')
  auditLogs(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.auditLogs(query);
  }

  @Get('feedback')
  feedback(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.listFeedback(query);
  }

  @Delete('users/:userId')
  deleteUser(
    @CurrentUser() actor: AuthUser,
    @Param('userId', new ZodPipe(uuid)) userId: string,
    @Body(new ZodPipe(DeleteUserRequest)) body: z.infer<typeof DeleteUserRequest>,
  ) {
    return this.admin.deleteUser(actor, userId, body);
  }
}
