import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';
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
  @ApiEndpoint({ tag: 'Admin', summary: 'Get platform usage, cost, and membership overview', security: 'bearer', errors: [401, 403] })
  overview() {
    return this.admin.overview();
  }

  @Get('users')
  @ApiEndpoint({ tag: 'Admin', summary: 'Search and paginate user accounts', security: 'bearer', errors: [400, 401, 403] })
  users(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.listUsers(query);
  }

  @Get('users/:userId')
  @ApiEndpoint({ tag: 'Admin', summary: 'Inspect a user, trips, membership, and usage', security: 'bearer', errors: [401, 403, 404] })
  user(@Param('userId', new ZodPipe(uuid)) userId: string) {
    return this.admin.getUser(userId);
  }

  @Post('users/:userId/pro-grants')
  @ApiEndpoint({ tag: 'Admin', summary: 'Grant complimentary Pro until a specified expiry', security: 'bearer', response: { status: 201, description: 'Pro grant created' }, errors: [400, 401, 403, 404, 409] })
  grantPro(
    @CurrentUser() actor: AuthUser,
    @Param('userId', new ZodPipe(uuid)) userId: string,
    @Body(new ZodPipe(CreateGrantRequest)) body: z.infer<typeof CreateGrantRequest>,
  ) {
    return this.admin.grantPro(actor, userId, body);
  }

  @Post('pro-grants/:grantId/revoke')
  @ApiEndpoint({ tag: 'Admin', summary: 'Revoke a complimentary Pro grant', security: 'bearer', response: { status: 201, description: 'Pro grant revoked' }, errors: [401, 403, 404, 409] })
  revokePro(
    @CurrentUser() actor: AuthUser,
    @Param('grantId', new ZodPipe(uuid)) grantId: string,
    @Body(new ZodPipe(RevokeGrantRequest)) body: z.infer<typeof RevokeGrantRequest>,
  ) {
    return this.admin.revokePro(actor, grantId, body);
  }

  @Get('billing')
  @ApiEndpoint({ tag: 'Admin', summary: 'View Stripe subscription references and statuses', security: 'bearer', errors: [400, 401, 403] })
  billing(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.billing(query);
  }

  @Get('audit-logs')
  @ApiEndpoint({ tag: 'Admin', summary: 'Read the admin audit log', security: 'bearer', errors: [400, 401, 403] })
  auditLogs(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.auditLogs(query);
  }

  @Get('feedback')
  @ApiEndpoint({ tag: 'Admin', summary: 'Review user-submitted feedback', security: 'bearer', errors: [400, 401, 403] })
  feedback(@Query(new ZodPipe(UserListQuery)) query: z.infer<typeof UserListQuery>) {
    return this.admin.listFeedback(query);
  }

  @Delete('users/:userId')
  @ApiEndpoint({ tag: 'Admin', summary: 'Delete an account and its local data', security: 'bearer', errors: [400, 401, 403, 404, 409] })
  deleteUser(
    @CurrentUser() actor: AuthUser,
    @Param('userId', new ZodPipe(uuid)) userId: string,
    @Body(new ZodPipe(DeleteUserRequest)) body: z.infer<typeof DeleteUserRequest>,
  ) {
    return this.admin.deleteUser(actor, userId, body);
  }
}
