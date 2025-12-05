# Exa MCP Server - Fork Enhancements

This document describes the features added to this fork of the [exa-mcp-server](https://github.com/exa-labs/exa-mcp-server).

These enhancements are designed for **self-hosted deployments** (e.g., Deno Deploy) where you want to share the server with multiple users while maintaining control over API key usage and access.

---

## Overview

| Feature | Description |
|---------|-------------|
| **Multi-Token Authentication** | Support multiple auth tokens instead of just one |
| **User Allocation** | Associate tokens with user identifiers for tracking |
| **Role-Based Access Control** | Admin vs User roles with different permissions |
| **Token Expiry** | Set expiration dates on tokens |
| **Usage Tracking** | Track per-token usage statistics |
| **Admin API** | Endpoint to view token statistics |
| **Persistent State** | Token state persists via Deno KV |

---

## 1. Multi-Token Authentication

### What It Does

Instead of a single `MCP_AUTH_TOKEN`, you can now configure multiple tokens with `MCP_AUTH_TOKENS`. Each token can have its own user, role, and expiry settings.

### Configuration

```bash
# Old way (still supported - creates single admin token)
MCP_AUTH_TOKEN="single-secret-token"

# New way - multiple tokens
MCP_AUTH_TOKENS="token1:user1:role1:expiry1,token2:user2:role2:expiry2,..."
```

### Token Format

```
token:userId:role:expiry
```

- **token** (required): The secret token string
- **userId** (optional): Identifier for the user (for tracking)
- **role** (optional): `admin` or `user` (default: `user`)
- **expiry** (optional): When the token expires

### Examples

```bash
# Admin token for alice, expires Dec 31, 2025
"abc123:alice:admin:2025-12-31"

# User token for bob, never expires
"xyz789:bob:user:never"

# Admin token, no user ID, never expires
"def456::admin"

# Minimal: anonymous user token, never expires
"simple_token"
```

---

## 2. User Allocation

### What It Does

Each token can be associated with a user identifier. This enables:

- Per-user usage tracking
- Identifying which user made requests (in debug logs)
- Usage statistics grouped by user

### How To Use

Include the user ID as the second field in the token configuration:

```bash
MCP_AUTH_TOKENS="token1:alice:user,token2:bob:user,token3:charlie:admin"
```

### Statistics Output

```json
{
  "tokensByUser": {
    "alice": 1,
    "bob": 1,
    "charlie": 1,
    "anonymous": 2
  }
}
```

---

## 3. Role-Based Access Control

### What It Does

Tokens have one of two roles that determine what endpoints they can access:

| Role | Description |
|------|-------------|
| `admin` | Full access to all endpoints including `/admin/*` |
| `user` | Access to MCP endpoints only |

### Permissions Matrix

| Endpoint | `user` Role | `admin` Role |
|----------|-------------|--------------|
| `GET /` `/health` | ✅ Allowed | ✅ Allowed |
| `GET /mcp/usage` | ✅ Allowed | ✅ Allowed |
| `POST /mcp` | ✅ Allowed | ✅ Allowed |
| `GET /admin/tokens` | ❌ 403 Forbidden | ✅ Allowed |

### Configuration

```bash
# Explicit admin role
"admin-token:alice:admin"

# Explicit user role
"user-token:bob:user"

# Default is user role
"basic-token:charlie"      # → role = user
"anonymous-token"          # → role = user
```

### Backward Compatibility

When using the legacy `MCP_AUTH_TOKEN` (single token), it defaults to `admin` role to maintain backward compatibility.

---

## 4. Token Expiry Control

### What It Does

Tokens can have an expiration date. Expired tokens are rejected with a 403 Forbidden response.

### Expiry Values

| Value | Meaning |
|-------|---------|
| `2025-12-31` | Expires on December 31, 2025 (ISO 8601) |
| `2025-06-15T23:59:59Z` | Expires at specific time (ISO 8601) |
| `never` | Never expires |
| `infinite` | Never expires |
| `∞` | Never expires |
| `none` | Never expires |
| `-` | Never expires |
| *(omitted)* | Never expires |

### Examples

```bash
# Expires on specific date
"temp-token:guest:user:2025-01-31"

# Explicitly never expires
"permanent:admin:admin:never"

# Implicitly never expires (field omitted)
"forever:user:user"
```

### Expired Token Response

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32001,
    "message": "Forbidden: Token has expired"
  },
  "id": null
}
```

---

## 5. Usage Tracking

### What It Does

The server tracks usage statistics for each token:

- **usageCount**: Total number of requests made with this token
- **lastUsedAt**: Timestamp of last request

### How to Query Your Usage

Any token (user or admin) can query its own usage via the `/mcp/usage` endpoint:

```bash
curl "https://your-server/mcp/usage" \
  -H "Authorization: Bearer my-token"
```

**Response:**
```json
{
  "userId": "alice",
  "role": "user",
  "expiresAt": "2025-12-31T00:00:00.000Z",
  "isExpired": false,
  "usageCount": 42,
  "lastUsedAt": "2025-12-05T10:30:00.000Z"
}
```

### Persistence

When running on Deno Deploy, token state (usage count, last used) is persisted using Deno KV and survives server restarts.

---

## 6. Admin API

### What It Does

Provides endpoints to view all tokens' statistics (admin only).

### Endpoint

```
GET /admin/tokens
```

### Authentication

Requires a token with `admin` role.

### Response

```json
{
  "stats": {
    "totalTokens": 3,
    "activeTokens": 2,
    "expiredTokens": 1,
    "totalUsage": 150,
    "tokensByUser": {
      "alice": 1,
      "bob": 1,
      "anonymous": 1
    }
  },
  "tokens": [
    {
      "tokenPrefix": "admin-to...",
      "userId": "alice",
      "role": "admin",
      "expiresAt": null,
      "isActive": true,
      "isExpired": false,
      "usageCount": 100,
      "lastUsedAt": "2025-12-05T10:30:00.000Z"
    }
  ]
}
```

**Note:** Token values are truncated (`tokenPrefix`) for security.

---

## 7. Working Modes

The server operates in one of two modes:

### Pool Mode

**When:** `MCP_AUTH_TOKEN` or `MCP_AUTH_TOKENS` is set

- Clients authenticate with bearer tokens
- Server uses shared `EXA_API_KEYS` for all requests
- Usage is tracked per token

### Passthrough Mode

**When:** No auth tokens configured

- No authentication required
- Each client provides their own Exa API key
- Original exa-mcp-server behavior

---

## Quick Start Example

### Environment Variables

```bash
# Exa API keys (the server uses these for all requests)
EXA_API_KEYS=exa-key-1,exa-key-2

# Auth tokens for your users
MCP_AUTH_TOKENS=admin-secret:admin:admin:never,alice-token:alice:user:2025-12-31,bob-token:bob:user:never

# Tools to enable
ENABLED_TOOLS=web_search_exa,get_code_context_exa,crawling_exa
```

### Client Usage

```bash
# Alice (user role) - can use MCP
curl -X POST "https://your-server/mcp" \
  -H "Authorization: Bearer alice-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize",...}'

# Admin - can view token stats
curl "https://your-server/admin/tokens" \
  -H "Authorization: Bearer admin-secret"

# Alice trying admin endpoint - DENIED
curl "https://your-server/admin/tokens" \
  -H "Authorization: Bearer alice-token"
# → 403 Forbidden: Admin token required
```

---

## Files Changed

This fork modifies/adds the following files:

| File | Change |
|------|--------|
| `src/utils/tokenManager.ts` | **New** - Multi-token management |
| `src/utils/authMiddleware.ts` | **Modified** - Uses TokenManager |
| `src/main_deno.ts` | **Modified** - Admin endpoint, enhanced auth |
| `docs/API.md` | **New** - API documentation |
| `docs/FORK_FEATURES.md` | **New** - This document |
