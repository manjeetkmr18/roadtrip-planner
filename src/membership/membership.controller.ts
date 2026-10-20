import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, JwtGuard, VerifiedGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';
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
  @ApiEndpoint({ tag: 'Membership', summary: 'List configured Stripe subscription plans', errors: [503] })
  plans() {
    return this.membership.plans();
  }

  @Get('me')
  @UseGuards(JwtGuard)
  @ApiEndpoint({ tag: 'Membership', summary: 'Get effective membership and subscription status', security: 'bearer', errors: [401] })
  me(@CurrentUser() user: AuthUser) {
    return this.membership.me(user);
  }

  @Get('usage')
  @UseGuards(JwtGuard)
  @ApiEndpoint({ tag: 'Membership', summary: 'Get monthly plan usage', security: 'bearer', errors: [401] })
  usage(@CurrentUser() user: AuthUser) {
    return this.membership.usage(user);
  }

  @Post('checkout')
  @UseGuards(VerifiedGuard)
  @ApiEndpoint({ tag: 'Membership', summary: 'Start a Stripe Checkout subscription', security: 'bearer', response: { status: 201, description: 'Checkout session created' }, errors: [400, 401, 403, 409, 503] })
  checkout(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CheckoutRequest)) body: CheckoutInput) {
    return this.membership.checkout(user, body);
  }

  @Post('portal')
  @UseGuards(VerifiedGuard)
  @ApiEndpoint({ tag: 'Membership', summary: 'Open the Stripe billing portal', security: 'bearer', response: { status: 201, description: 'Billing portal session created' }, errors: [401, 403, 409, 503] })
  portal(@CurrentUser() user: AuthUser) {
    return this.membership.portal(user);
  }

  @Post('webhook')
  @HttpCode(200)
  @ApiEndpoint({ tag: 'Membership', summary: 'Receive a signed Stripe subscription webhook', errors: [400, 503] })
  webhook(@Req() request: StripeWebhookRequest) {
    if (!this.env.STRIPE_WEBHOOK_SECRET) throw new ServiceUnavailableException('Subscription webhooks are not configured');
    if (!request.rawBody) throw new Error('Stripe webhook requires raw request-body support');
    const signature = request.headers['stripe-signature'];
    if (!signature || Array.isArray(signature)) throw new BadRequestException('Stripe signature header is missing');
    return this.membership.handleWebhook(request.rawBody, signature);
  }
}
