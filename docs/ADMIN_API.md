# Admin API

The API exposes a separate `/api/admin` surface for platform monitoring and support. It uses the existing user login flow, but every admin request checks the user's persisted `users.role` in the database. A role claim from a JWT or browser is never accepted as authorization.

The web app exposes the same monitoring and support tools at `/admin` after an administrator signs in. The admin dashboard can inspect users, their trips, membership and usage, review billing references, feedback and audit events, and grant or revoke complimentary Pro access. Frontend role checks control navigation only; every operation remains protected by the API's database-backed admin guard. The dashboard does not impersonate users or grant access to their private trip routes.

Administrator accounts are treated as Pro for API entitlement and free-trip quota checks, based on the persisted role. This allows admins to exercise Pro-only features, including guided arrival adjustments, but trip generation and arrival previews can call paid provider APIs and incur costs.

## Bootstrap the first admin

1. Deploy the API code and apply database migrations, including `0006_admin_membership`.
2. Create a normal account and verify its email.
3. Using a trusted database connection, promote that account by its known email:

   ```sql
   UPDATE users
   SET role = 'admin'
   WHERE email = 'your-verified-admin@example.com'
   RETURNING id, email, role;
   ```

   Confirm exactly one expected account was returned. Do not expose database credentials to the browser or put them in frontend environment variables.
4. Sign in through `POST /api/auth/login` and send the returned bearer token to `/api/admin/*`. `/api/auth/me` and `/api/users/me` include the current role.

To remove admin access, set that account's role back to `user` in the database. The guard checks the database on every admin request, so role changes take effect without waiting for the JWT to expire.

## Available endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/overview` | Counts for users, trips, monthly generations/failures/cost, feedback, and active memberships |
| GET | `/api/admin/users?q=&limit=&offset=` | Search accounts (never returns password hashes) |
| GET | `/api/admin/users/:userId` | Inspect account, trip plans, subscription references, grants, and generation usage |
| GET | `/api/admin/billing?limit=&offset=` | View Stripe customer/subscription/price identifiers and subscription lifecycle state |
| POST | `/api/admin/users/:userId/pro-grants` | Grant complimentary Pro with `expiresAt` and an audit reason |
| POST | `/api/admin/pro-grants/:grantId/revoke` | Revoke a complimentary grant with an audit reason |
| GET | `/api/admin/audit-logs?limit=&offset=` | Review recorded admin membership and account-deletion actions |
| GET | `/api/admin/feedback?limit=&offset=` | Review user feedback and linked account references |
| DELETE | `/api/admin/users/:userId` | Permanently delete an account and cascading local trip data |

Grant example:

```json
{
  "expiresAt": "2027-10-20T00:00:00.000Z",
  "reason": "Complimentary access approved for customer support"
}
```

The grant is independent of Stripe. It is enforced by API membership checks and generation admission, expires automatically, and does not start billing. Revocation and deletion are recorded in `admin_audit_logs`.

Account deletion requires a JSON body containing the exact target ID and a reason:

```json
{
  "confirmUserId": "user-uuid-from-the-path",
  "reason": "Deletion requested by account owner"
}
```

The API refuses to delete the signed-in admin, the last admin, or an account with a current Stripe subscription. Cancel the Stripe subscription first. Deletion cascades to that account's local trips, plans, generations, and membership records; Stripe-side records are not deleted by this API.

Admin APIs intentionally do not expose password hashes, JWT secrets, database credentials, or Stripe secret keys.
