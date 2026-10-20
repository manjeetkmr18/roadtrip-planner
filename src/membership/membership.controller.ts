import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, JwtGuard, VerifiedGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { CheckoutRequest, type CheckoutInput, MembershipService } from './membership.service.js';

type StripeWebhookRequest = Request & { rawBody?: Buffer };

@Controller('membership')
export class MembershipController {
  constructor(
    private readonly membership: MembershipService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('plans')
  plans() {
    return this.membership.plans();
  }

  @Get('me')
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.membership.me(user);
  }

  @Get('usage')
  @UseGuards(JwtGuard)
  usage(@CurrentUser() user: AuthUser) {
    return this.membership.usage(user);
  }

  @Post('checkout')
  @UseGuards(VerifiedGuard)
  checkout(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CheckoutRequest)) body: CheckoutInput) {
    return this.membership.checkout(user, body);
  }

  @Post('portal')
  @UseGuards(VerifiedGuard)
  portal(@CurrentUser() user: AuthUser) {
    return this.membership.portal(user);
  }

  @Post('webhook')
  @HttpCode(200)
  webhook(@Req() request: StripeWebhookRequest) {
    if (!this.env.STRIPE_WEBHOOK_SECRET) throw new ServiceUnavailableException('Subscription webhooks are not configured');
    if (!request.rawBody) throw new Error('Stripe webhook requires raw request-body support');
    const signature = request.headers['stripe-signature'];
    if (!signature || Array.isArray(signature)) throw new BadRequestException('Stripe signature header is missing');
    return this.membership.handleWebhook(request.rawBody, signature);
  }
}
