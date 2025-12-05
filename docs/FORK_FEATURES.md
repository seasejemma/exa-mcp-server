# Exa MCP Server - Fork Enhancements

This document describes the features added to this fork of the [exa-mcp-server](https://github.com/exa-labs/exa-mcp-server).

These enhancements are designed for **self-hosted deployments** (e.g., Deno Deploy) where you want to share the server with multiple users while maintaining control over API key usage and access.

---

## Overview

| Feature | Description |
|---------|--------------|
| **Multi-Token Authentication** | Support multiple user tokens plus one admin token |
| **User Allocation** | Associate tokens with user identifiers for tracking |
| **Token Expiry** | Set expiration dates on tokens |
| **Usage Tracking** | Track per-token usage statistics |
| **Admin API** | Endpoint to view token statistics |
| **Persistent State** | Token state persists via Deno KV |

---

## 1. Multi-Token Authentication

### What It Does

The server supports two types of tokens:

1. **Admin Token** (`MCP_AUTH_TOKEN`): Single token with full access
2. **User Tokens** (`USER_TOKENS`): Multiple tokens with MCP-only access

### Configuration

```bash
# Admin token (full access including /admin/* endpoints)
MCP_AUTH_TOKEN="admin-secret-token"

# User tokens (MCP access only)
USER_TOKENS="token1:user1:expiry1,token2:user2:expiry2,..."
```

### Token Format

**USER_TOKENS format:**
```
token:userId:expiry
```

- **token** (required): The secret token string
- **userId** (optional): Identifier for the user (for tracking)
- **expiry** (optional): When the token expires

### Examples

```bash
# User token for alice, expires Dec 31, 2025
"abc123:alice:2025-12-31"

# User token for bob, never expires
"xyz789:bob:never"

# User token, no user ID, never expires
"def456"

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
USER_TOKENS="token1:alice,token2:bob,token3:charlie"
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

Tokens are assigned roles based on how they're configured:

| Token Source | Role | Description |
|--------------|------|-------------|
| `MCP_AUTH_TOKEN` | `admin` | Full access to all endpoints including `/admin/*` |
| `USER_TOKENS` | `user` | Access to MCP endpoints only |

### Permissions Matrix

| Endpoint | `user` Role | `admin` Role |
|----------|-------------|---------------|
| `GET /` `/health` | ✅ Allowed | ✅ Allowed |
| `GET /mcp/usage` | ✅ Allowed | ✅ Allowed |
| `POST /mcp` | ✅ Allowed | ✅ Allowed |
| `GET /admin/tokens` | ❌ 403 Forbidden | ✅ Allowed |

### Configuration

```bash
# Admin token (full access)
MCP_AUTH_TOKEN="admin-token-here"

# User tokens (MCP access only)
USER_TOKENS="user-token:bob,user-token2:charlie"
```

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
# Expires on specific date (USER_TOKENS)
"temp-token:guest:2025-01-31"

# Explicitly never expires
"permanent:admin:never"

# Implicitly never expires (field omitted)
"forever:user"
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

**When:** `MCP_AUTH_TOKEN` or `USER_TOKENS` is set

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

# Admin token (full access)
MCP_AUTH_TOKEN=admin-secret

# User tokens (MCP access only)
USER_TOKENS=alice-token:alice:2025-12-31,bob-token:bob:never

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
