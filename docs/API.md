# Exa MCP Server API Reference

This document describes the HTTP API endpoints and authentication system for the self-hosted Exa MCP Server.

## Authentication

### Token-Based Authentication

The server uses Bearer token authentication. Include the token in the `Authorization` header:

```http
Authorization: Bearer <your-token>
```

### Token Configuration

Tokens are configured via environment variables:

| Variable | Description |
|----------|-------------|
| `MCP_AUTH_TOKEN` | Single admin token (full access) |
| `USER_TOKENS` | Multiple user tokens (MCP access only) |

### Token Format

**MCP_AUTH_TOKEN** (admin):
```
token
```

**USER_TOKENS** (users):
```
token:userId:expiry
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | ✅ Yes | - | The authentication token string |
| `userId` | No | `null` | User identifier for tracking/analytics |
| `expiry` | No | never | Expiration date or special value |

### Expiry Values

| Value | Description |
|-------|-------------|
| `2025-12-31` | ISO 8601 date - expires on that date |
| `never` | Never expires (explicit) |
| `infinite` | Never expires (explicit) |
| `∞` | Never expires (explicit) |
| `none` | Never expires (explicit) |
| `-` | Never expires (explicit) |
| *(empty)* | Never expires (implicit) |

### Configuration Examples

```bash
# Admin token (full access)
MCP_AUTH_TOKEN="admin-secret-token"

# User tokens with different configurations
USER_TOKENS="user-key:bob:2025-12-31,temp-key:guest:2025-01-15,anon-key"
```

---

## Endpoints

### Health Check

Check server status and configuration.

```http
GET /
GET /health
```

**Authentication:** Not required

**Response:**
```json
{
  "status": "ok",
  "server": "exa-mcp-server",
  "version": "3.1.2",
  "mode": "pool",
  "authRequired": true
}
```

| Field | Description |
|-------|-------------|
| `mode` | `pool` (using shared API keys) or `passthrough` (client provides key) |
| `authRequired` | Whether authentication is required |

---

### My Token Usage

Query your own token's usage and status.

```http
GET /mcp/usage
```

**Authentication:** Required (any valid token)

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

| Field | Description |
|-------|-------------|
| `userId` | Your user identifier (or `null` if anonymous) |
| `role` | Your role: `admin` or `user` |
| `expiresAt` | When your token expires (`null` = never) |
| `isExpired` | Whether your token has expired |
| `usageCount` | Total requests made with your token |
| `lastUsedAt` | Timestamp of your last request |

---

### MCP Protocol

The main MCP (Model Context Protocol) endpoint.

```http
POST /mcp
GET /mcp
DELETE /mcp
```

**Authentication:** Required (any valid token - `admin` or `user` role)

**Headers:**
```http
Authorization: Bearer <token>
Content-Type: application/json
Mcp-Session-Id: <session-id>  # For existing sessions
```

#### POST /mcp - Send MCP Request

Initialize a session or send MCP messages.

**Request (Initialize):**
```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "my-client",
      "version": "1.0"
    }
  },
  "id": 1
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "protocolVersion": "2024-11-05",
    "serverInfo": {
      "name": "exa-search-server",
      "version": "3.1.2"
    },
    "capabilities": {
      "tools": {}
    }
  },
  "id": 1
}
```

#### GET /mcp - SSE Stream

Establish Server-Sent Events stream for notifications.

**Headers:**
```http
Authorization: Bearer <token>
Mcp-Session-Id: <session-id>
Accept: text/event-stream
```

#### DELETE /mcp - Close Session

Terminate an MCP session.

**Headers:**
```http
Authorization: Bearer <token>
Mcp-Session-Id: <session-id>
```

**Response:** `204 No Content`

---

### Admin: Token Statistics

View token usage statistics and list all configured tokens.

```http
GET /admin/tokens
```

**Authentication:** Required (`admin` role only)

**Response:**
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
      "tokenPrefix": "admin-ke...",
      "userId": "alice",
      "role": "admin",
      "expiresAt": null,
      "isActive": true,
      "isExpired": false,
      "usageCount": 100,
      "lastUsedAt": "2025-12-05T10:30:00.000Z"
    },
    {
      "tokenPrefix": "user-key...",
      "userId": "bob",
      "role": "user",
      "expiresAt": "2025-12-31T00:00:00.000Z",
      "isActive": true,
      "isExpired": false,
      "usageCount": 50,
      "lastUsedAt": "2025-12-05T09:15:00.000Z"
    }
  ]
}
```

---

## Error Responses

### 401 Unauthorized

Returned when authentication fails.

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Unauthorized: Invalid or missing authentication token"
  },
  "id": null
}
```

**Causes:**
- Missing `Authorization` header
- Invalid token format (not `Bearer <token>`)
- Token not found in configuration

### 403 Forbidden

Returned when authentication succeeds but access is denied.

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

**Causes:**
- Token has expired
- Token is disabled
- `user` role attempting to access admin endpoints

### 404 Not Found

Returned for unknown endpoints.

```
Not found
```

### 405 Method Not Allowed

Returned for unsupported HTTP methods.

```
Method not allowed
```

---

## Roles & Permissions

| Role | `/` `/health` | `/mcp/usage` | `/mcp` | `/admin/*` |
|------|---------------|--------------|--------|------------|
| *(no auth)* | ✅ | ❌ 401 | ❌ 401 | ❌ 401 |
| `user` | ✅ | ✅ | ✅ | ❌ 403 |
| `admin` | ✅ | ✅ | ✅ | ✅ |

---

## Working Modes

### Pool Mode

When `MCP_AUTH_TOKEN` or `USER_TOKENS` is configured:

- Clients must authenticate with bearer tokens
- Server uses `EXA_API_KEYS` for Exa API calls
- Token usage is tracked

### Passthrough Mode

When no auth tokens are configured:

- No authentication required
- Clients provide their own Exa API key
- Via query parameter: `?exaApiKey=<key>`
- Via header: `X-Exa-Api-Key: <key>`

---

## Usage Examples

### Initialize Session

```bash
curl -X POST "https://your-server/mcp" \
  -H "Authorization: Bearer admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "curl", "version": "1.0"}
    },
    "id": 1
  }'
```

### Call a Tool

```bash
curl -X POST "https://your-server/mcp" \
  -H "Authorization: Bearer user-key" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id-from-init>" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "web_search_exa",
      "arguments": {
        "query": "latest AI news"
      }
    },
    "id": 2
  }'
```

### Check Your Own Usage (Any Token)

```bash
curl "https://your-server/mcp/usage" \
  -H "Authorization: Bearer user-key"

# Response:
# {
#   "userId": "bob",
#   "role": "user",
#   "expiresAt": "2025-12-31T00:00:00.000Z",
#   "isExpired": false,
#   "usageCount": 42,
#   "lastUsedAt": "2025-12-05T10:30:00.000Z"
# }
```

### Get All Token Stats (Admin Only)

```bash
curl "https://your-server/admin/tokens" \
  -H "Authorization: Bearer admin-key"
```

### Attempt Admin Access with User Token (Fails)

```bash
curl "https://your-server/admin/tokens" \
  -H "Authorization: Bearer user-key"

# Response: 403 Forbidden
# {"jsonrpc":"2.0","error":{"code":-32001,"message":"Forbidden: Admin token required"},"id":null}
```
