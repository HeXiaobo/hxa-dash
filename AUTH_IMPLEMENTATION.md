# Feishu OAuth 2.0 Authentication Implementation for hxa-dash

## Summary

Implemented Feishu OAuth 2.0 authentication system for hxa-dash (Express.js) to restrict access to Zhiwai employees only. The system allows all `/api/*` routes to remain unprotected (for bot health-reporter access) while protecting all HTML pages and static assets.

## Implementation Files

### 1. Authentication Modules

#### `src/auth/feishu.js`
- **Purpose**: Feishu OAuth client
- **Functions**:
  - `getAppAccessToken()` - Get or refresh Feishu app access token (with caching)
  - `buildAuthorizeUrl(redirectUri, state)` - Build OAuth authorize URL
  - `exchangeCodeForUser(code)` - Exchange auth code for user info

#### `src/auth/jwt.js`
- **Purpose**: JWT token management
- **Uses**: `jsonwebtoken` package (CommonJS compatible)
- **Functions**:
  - `signToken(payload)` - Sign JWT with user info (30-day expiration)
  - `verifyToken(token)` - Verify JWT signature and issuer
- **Token Issuer**: `hxa-dash`
- **Algorithm**: HS256

#### `src/auth/middleware.js`
- **Purpose**: Express middleware for authentication
- **Behavior**:
  - Skips `/api/*` routes (bots can call these freely)
  - Skips `/auth/*` routes (login, callback, denied)
  - Protects all other routes (HTML, JS, CSS, etc.)
  - Verifies `hxa_token` cookie contains valid JWT
  - Checks `tenant_key` from JWT matches `FEISHU_TENANT_KEY`
  - Redirects unauthorized users to `/auth/login`
- **User Data**: Stores verified payload in `req.user` for downstream use

### 2. Auth Routes

#### `src/routes/auth.js`
- **Purpose**: OAuth and access control endpoints
- **Routes**:
  - `GET /auth/login` - Redirect to Feishu OAuth authorize URL
  - `GET /auth/callback` - Handle OAuth callback, sign JWT, set cookie
  - `GET /auth/logout` - Clear cookie and redirect to login
  - `GET /auth/denied` - Access denied page (custom HTML with friendly messages)

**Flow**:
1. User visits `/` → redirected to `/auth/login?return_to=/`
2. Clicks "Login" → redirected to Feishu OAuth authorize
3. User logs in with Feishu account → redirected to `/auth/callback?code=...`
4. Callback validates:
   - Code is valid
   - User's `tenant_key` matches Zhiwai's tenant (from `FEISHU_TENANT_KEY`)
5. If valid: Signs JWT, sets `hxa_token` cookie, redirects to original page
6. If invalid: Redirects to `/auth/denied` with reason

### 3. Configuration

#### `.env.example`
Documents required environment variables:
- `FEISHU_APP_ID` - Feishu bot app ID (cli_a940cff668b81bde)
- `FEISHU_APP_SECRET` - Bot secret
- `FEISHU_TENANT_KEY` - Zhiwai's tenant key (for whitelist verification)
- `JWT_SECRET` - Random 32+ char string for JWT signing

## Server Integration

### Changes to `src/server.js`

1. **Import Dependencies**
   ```javascript
   const cookieParser = require('cookie-parser');
   const authRoutes = require('./routes/auth');
   const authMiddleware = require('./auth/middleware');
   ```

2. **Mount Cookie Parser** (before routes)
   ```javascript
   app.use(cookieParser());
   ```

3. **Mount Auth Routes** (before API routes, so login/callback are accessible)
   ```javascript
   app.use('/auth', authRoutes);
   ```

4. **API Routes** (after auth routes, unprotected)
   - All `/api/*` routes remain accessible without authentication
   - Bots can call health-check, webhooks, etc.

5. **Auth Middleware** (after API routes, before static files)
   ```javascript
   app.use(authMiddleware);
   ```
   - Protects HTML pages and static assets
   - Verifies tenant_key matches Zhiwai

6. **Static File Serving** (after middleware)
   ```javascript
   app.use(express.static(path.join(__dirname, '..', 'public'), ...));
   ```

### Middleware Execution Order

```
cookieParser()
    ↓
auth routes (/auth/*)
    ↓
API routes (/api/*) — unprotected
    ↓
auth middleware — protect everything else
    ↓
static files
```

## Package Dependencies

Added to `package.json`:
- `cookie-parser@^1.4.6` - Parse HTTP cookies
- `jsonwebtoken@^9.0.0` - JWT signing/verification (CommonJS compatible)

## Token Format

JWT payload contains user info from Feishu:
```javascript
{
  open_id: "ou_xxx",
  union_id: "on_xxx",
  name: "张三",
  avatar_url: "https://...",
  tenant_key: "2ca123456789abcd",
  iat: 1234567890,
  exp: 1234567890,
  iss: "hxa-dash"
}
```

## Security

1. **Token Signing**: HS256 with `JWT_SECRET` env var
2. **Expiration**: 30 days
3. **Tenant Whitelist**: Only users with `tenant_key === FEISHU_TENANT_KEY` are allowed
4. **Cookie Security**:
   - HttpOnly: true (prevents JavaScript access)
   - Secure: true in production (HTTPS only)
   - SameSite: lax (CSRF protection)
   - Path: / (available to entire application)
5. **API Routes**: Remain open for bot access (no authentication required)

## Testing

### Verify Module Syntax
```bash
node -c src/auth/feishu.js
node -c src/auth/jwt.js
node -c src/auth/middleware.js
node -c src/routes/auth.js
```

### Verify Server Parses
```bash
node -c src/server.js
```

### Verify Dependencies
```bash
npm ls
```

All dependencies installed successfully:
- cookie-parser@1.4.7
- jsonwebtoken@9.0.3
- express@4.22.1
- better-sqlite3@12.9.0
- ws@8.19.0

## Environment Setup

1. Copy `.env.example` to `.env`
2. Fill in required values:
   ```bash
   FEISHU_APP_ID=cli_a940cff668b81bde
   FEISHU_APP_SECRET=<get from Feishu Admin>
   FEISHU_TENANT_KEY=<Zhiwai tenant key>
   JWT_SECRET=<generate: openssl rand -hex 32>
   ```
3. Start server: `npm start`

## Access Control Matrix

| Route | Auth Required | Notes |
|-------|---------------|-------|
| `/api/*` | NO | Health reporters, webhooks, bots |
| `/auth/login` | NO | OAuth entry point |
| `/auth/callback` | NO | OAuth callback |
| `/auth/logout` | NO | Accessible to anyone |
| `/auth/denied` | NO | Access denied page |
| `/` (index.html) | YES | Main dashboard |
| `/css/*`, `/js/*` | YES | Static assets |
| `/*.js`, `/*.css` | YES | All static resources |

## Differences from Reference (zhiwai)

- **CommonJS** instead of TypeScript/ESM
- **jsonwebtoken** instead of jose (for CommonJS compatibility)
- **Cookie name**: `hxa_token` instead of `zhiwai_token`
- **Issuer**: `hxa-dash` instead of `zhiwai-dashboard`
- **Whitelist**: Tenant key check instead of Bitable database lookup
- **No dashboard-specific access**: All Zhiwai employees have full access (no granular permission)

## Known Limitations

1. **No logout**: Cookie persists for 30 days. User must wait for expiration or manually delete cookie.
   - Could be enhanced with server-side token blacklist/revocation list
   
2. **No session management**: Stateless JWT means no way to force logout across all sessions.
   - Would require session store (Redis, DB) to implement

3. **Tenant validation only**: No per-user role/permission model.
   - All Zhiwai employees have equal access
   - Could be enhanced with roles stored in Feishu or database

## Future Enhancements

1. Add logout endpoint with session management
2. Implement role-based access control (RBAC)
3. Add user profile page showing login info
4. Cache tenant whitelist for performance
5. Add audit logging for auth events
6. Support account linking for multiple Feishu organizations
