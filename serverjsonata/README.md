# JSONata Federation

`hrbolek/jsonata-federation` is a lightweight Dockerized API gateway that exposes a GraphQL-like endpoint over one or more REST/HTTP APIs.

It uses:

- GraphQL syntax as a request/query language,
- JSON endpoint registry loaded at runtime,
- JSONata expressions for request and response transformations,
- selection-set based field projection and renaming,
- optional forwarding of selected headers such as cookies and authorization tokens.

The main use case is to create a small configurable facade over heterogeneous REST APIs without writing a full GraphQL server or requiring OpenAPI specifications.

---

## Docker image

```bash
docker pull hrbolek/jsonata-federation:latest
```

Available image variants may include:

```text
hrbolek/jsonata-federation:latest
hrbolek/jsonata-federation:node22-alpine
hrbolek/jsonata-federation:node22-bookworm-slim
hrbolek/jsonata-federation:node20-alpine
hrbolek/jsonata-federation:node20-bookworm-slim
```

---

## Exposed endpoints

The container exposes port `3000` by default.

| Endpoint | Method | Description |
|---|---:|---|
| `/graphql` | `POST` | Main GraphQL-like gateway endpoint |
| `/health` | `GET` | Basic health check |
| `/health` | `POST` | Echo endpoint useful for testing transformations |
| `/debug` | `GET` | Built-in fixed debug call to `/graphql` |
| `/debug/query` | `GET` | Debug endpoint that accepts query and variables from URL query params |

---

## Quick start with Docker Compose

Create `docker-compose.yml`:

```yaml
services:
  serverjsonata:
    image: hrbolek/jsonata-federation:latest
    ports:
      - "8303:3000"
    environment:
      PORT: "3000"
      ENDPOINTS_CONFIG_PATH: /app/config/endpoints.json
      FORWARD_HEADERS: cookie,authorization,accept-language,x-request-id
    volumes:
      - ./serverjsonata/endpoints.json:/app/config/endpoints.json:ro
```

Start the container:

```bash
docker compose up
```

The gateway is then available at:

```text
http://localhost:8303/graphql
```

---

## Configuration

Endpoint configuration can be provided in two ways.

### Option 1: Configuration file

Set:

```bash
ENDPOINTS_CONFIG_PATH=/app/config/endpoints.json
```

and mount your configuration file into the container:

```yaml
volumes:
  - ./serverjsonata/endpoints.json:/app/config/endpoints.json:ro
```

### Option 2: JSON directly in ENV

For small demos, you can provide the full configuration as an environment variable:

```bash
ENDPOINTS_JSON='[
  {
    "name": "healthOne",
    "method": "POST",
    "url": "http://localhost:3000/health"
  }
]'
```

If both `ENDPOINTS_JSON` and `ENDPOINTS_CONFIG_PATH` are provided, `ENDPOINTS_JSON` has priority.

---

## Example `endpoints.json`

This example defines two logical endpoints. Both call the same internal test endpoint `POST /health`, but each uses a different request and response transformation.

```json
[
  {
    "name": "healthOne",
    "method": "POST",
    "url": "http://localhost:3000/health",
    "forwardHeaders": true,
    "requestTransform": "{ \"id\": args.id, \"name\": args.name, \"source\": \"healthOne\", \"nested\": { \"value\": args.value } }",
    "responseTransform": "{ \"ok\": ok, \"service\": \"self-health-one\", \"requestMethod\": method, \"originalPayload\": payload, \"payloadId\": payload.id, \"payloadName\": payload.name, \"payloadValue\": payload.nested.value, \"forwardedHeaders\": forwardedHeaders }",
    "selectionMap": {
      "ok": "ok",
      "service": "service",
      "method": "requestMethod",
      "id": "payloadId",
      "name": "payloadName",
      "value": "payloadValue",
      "payload": "originalPayload",
      "forwardedHeaders": "forwardedHeaders"
    }
  },
  {
    "name": "healthTwo",
    "method": "POST",
    "url": "http://localhost:3000/health",
    "forwardHeaders": true,
    "requestTransform": "{ \"external_id\": args.id, \"display_name\": args.name, \"source\": \"healthTwo\", \"meta\": { \"amount\": args.value } }",
    "responseTransform": "{ \"ok\": ok, \"service\": \"self-health-two\", \"requestMethod\": method, \"raw\": payload, \"id\": payload.external_id, \"title\": payload.display_name, \"amount\": payload.meta.amount, \"forwardedHeaders\": forwardedHeaders }",
    "selectionMap": {
      "ok": "ok",
      "service": "service",
      "method": "requestMethod",
      "id": "id",
      "name": "title",
      "value": "amount",
      "payload": "raw",
      "forwardedHeaders": "forwardedHeaders"
    }
  }
]
```

---

## Endpoint configuration reference

Each endpoint can have the following properties.

| Property | Required | Description |
|---|---:|---|
| `name` | yes | Root GraphQL field name used to select the endpoint |
| `method` | no | HTTP method. Defaults to `GET` |
| `url` | yes/no | Static upstream URL |
| `urlTemplate` | yes/no | URL template with placeholders, for example `/users/{id}` |
| `headers` | no | Static headers added to the upstream request |
| `forwardHeaders` | no | If `true`, selected incoming headers are forwarded |
| `requestTransform` | no | JSONata expression evaluated against `{ args, variables }` |
| `responseTransform` | no | JSONata expression evaluated against the upstream JSON response |
| `selectionMap` | no | Maps public GraphQL field names to transformed/upstream JSON fields |

At least one of `url` or `urlTemplate` is required.

---

## URL templates

Use `urlTemplate` when GraphQL arguments should be inserted into the upstream URL.

```json
{
  "name": "userById",
  "method": "GET",
  "urlTemplate": "https://api.example.com/users/{id}",
  "selectionMap": {
    "id": "user_id",
    "name": "full_name"
  }
}
```

Request:

```graphql
query {
  userById(id: 10) {
    id
    name
  }
}
```

The upstream URL becomes:

```text
https://api.example.com/users/10
```

---

## Request transformation

`requestTransform` is a JSONata expression evaluated against:

```json
{
  "args": {},
  "variables": {}
}
```

Example:

```json
{
  "name": "userSearch",
  "method": "POST",
  "url": "https://api.example.com/users/search",
  "requestTransform": "{ \"search\": args.term, \"limit\": args.limit ? args.limit : 20 }"
}
```

GraphQL request:

```graphql
query {
  userSearch(term: "john", limit: 5) {
    items {
      id
      name
    }
  }
}
```

The upstream POST body becomes:

```json
{
  "search": "john",
  "limit": 5
}
```

---

## Response transformation

`responseTransform` is a JSONata expression evaluated against the raw upstream JSON response.

Example upstream response:

```json
{
  "user_id": 10,
  "full_name": "Jan Novak",
  "address": {
    "city": "Brno"
  }
}
```

Endpoint configuration:

```json
{
  "name": "userById",
  "method": "GET",
  "urlTemplate": "https://api.example.com/users/{id}",
  "responseTransform": "{ \"id\": user_id, \"name\": full_name, \"city\": address.city }"
}
```

Transformed response:

```json
{
  "id": 10,
  "name": "Jan Novak",
  "city": "Brno"
}
```

---

## Selection map and field renaming

`selectionMap` maps public GraphQL field names to JSONata paths or expressions.

```json
{
  "selectionMap": {
    "id": "user_id",
    "name": "full_name",
    "city": "address.city"
  }
}
```

GraphQL request:

```graphql
query {
  user: userById(id: 10) {
    id
    displayName: name
    city
  }
}
```

Response:

```json
{
  "data": {
    "user": {
      "id": 10,
      "displayName": "Jan Novak",
      "city": "Brno"
    }
  }
}
```

The GraphQL alias `displayName: name` is preserved in the final response.

---

## Nested selection map

Nested objects and arrays can be mapped using `path` and `fields`.

```json
{
  "name": "userSearch",
  "method": "POST",
  "url": "https://api.example.com/users/search",
  "responseTransform": "{ \"items\": users, \"total\": total_count }",
  "selectionMap": {
    "items": {
      "path": "items",
      "fields": {
        "id": "user_id",
        "name": "full_name",
        "city": "address.city"
      }
    },
    "total": "total"
  }
}
```

GraphQL request:

```graphql
query {
  userSearch(term: "john") {
    total
    items {
      id
      name
      city
    }
  }
}
```

---

## Header forwarding

Header forwarding is controlled by a global whitelist and per-endpoint opt-in.

Default forwarded headers:

```text
cookie,authorization,accept-language
```

You can override the whitelist with:

```bash
FORWARD_HEADERS=cookie,authorization,accept-language,x-request-id
```

To enable forwarding for an endpoint:

```json
{
  "name": "userById",
  "method": "GET",
  "urlTemplate": "https://api.example.com/users/{id}",
  "forwardHeaders": true
}
```

To disable global forwarding completely, set:

```bash
FORWARD_HEADERS=
```

The following hop-by-hop headers are never forwarded:

```text
host
connection
content-length
transfer-encoding
upgrade
keep-alive
proxy-authenticate
proxy-authorization
te
trailer
```

---

## Testing

### Health check

```bash
curl http://localhost:8303/health
```

### POST health echo

```bash
curl -X POST http://localhost:8303/health \
  -H "content-type: application/json" \
  -d '{"hello":"world"}'
```

Expected response:

```json
{
  "ok": true,
  "method": "POST",
  "endpoints": 2,
  "forwardedHeaders": [
    "cookie",
    "authorization",
    "accept-language",
    "x-request-id"
  ],
  "payload": {
    "hello": "world"
  }
}
```

### GraphQL gateway test

```bash
curl -X POST http://localhost:8303/graphql \
  -H "content-type: application/json" \
  -H "authorization: Bearer test-token" \
  -H "x-request-id: abc-123" \
  -d '{
    "query": "query { one: healthOne(id: 10, name: \"Alpha\", value: 42) { ok service method id name value payload forwardedHeaders } two: healthTwo(id: 20, name: \"Beta\", value: 84) { ok service method id name value payload forwardedHeaders } }"
  }'
```

### Debug endpoint with fixed query

```bash
curl http://localhost:8303/debug
```

### Debug endpoint with query from URL

```bash
curl --get http://localhost:8303/debug/query \
  --data-urlencode 'query=query { first: healthOne(id: 1, name: "Test", value: 123) { isOk: ok endpoint: service requestMethod: method renamedId: id renamedName: name renamedValue: value } }'
```

Direct browser URL:

```text
http://localhost:8303/debug/query?query=query%20%7B%20first%3A%20healthOne(id%3A%201%2C%20name%3A%20%22Test%22%2C%20value%3A%20123)%20%7B%20isOk%3A%20ok%20endpoint%3A%20service%20requestMethod%3A%20method%20renamedId%3A%20id%20renamedName%3A%20name%20renamedValue%3A%20value%20%7D%20%7D
```

### Debug endpoint with variables

```bash
curl --get http://localhost:8303/debug/query \
  --data-urlencode 'query=query TestQuery($id: Int!, $name: String!, $value: Int!) { first: healthOne(id: $id, name: $name, value: $value) { isOk: ok endpoint: service renamedId: id renamedName: name renamedValue: value } }' \
  --data-urlencode 'variables={"id":7,"name":"FromVars","value":777}'
```

---

## Docker build

The Dockerfile supports alternative base images through the `NODE_IMAGE` build argument.

```dockerfile
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
```

Build with the default base image:

```bash
docker build -f Dockerfile.JSONata -t hrbolek/jsonata-federation .
```

Build with an alternative base image:

```bash
docker build \
  -f Dockerfile.JSONata \
  --build-arg NODE_IMAGE=node:22-bookworm-slim \
  -t hrbolek/jsonata-federation:node22-bookworm-slim .
```

---

## GitHub Actions

A release workflow can build and publish multiple image variants using a matrix:

```text
node:22-alpine
node:22-bookworm-slim
node:20-alpine
node:20-bookworm-slim
```

Required GitHub secrets:

```text
DOCKER_USERNAME
DOCKER_PASSWORD
```

Recommended image name:

```text
hrbolek/jsonata-federation
```

---

## Design notes

This project is not a full GraphQL server with schema validation and type-safe resolvers. It is a lightweight GraphQL-like facade for HTTP APIs.

It is useful when:

- upstream APIs do not have OpenAPI specifications,
- several REST APIs need to be unified quickly,
- field names and payload shapes differ between services,
- transformations should be configured instead of hard-coded,
- a small Dockerized adapter is preferred over a larger API gateway platform.

---

## Security notes

Be careful with header forwarding.

Forwarding `cookie` or `authorization` means that upstream services receive the caller's authentication context. This is often desirable for internal services, but it should be explicitly controlled.

Recommended practice:

- keep `FORWARD_HEADERS` as a whitelist,
- enable `forwardHeaders` only for trusted endpoints,
- avoid forwarding headers to third-party APIs unless intended,
- do not log sensitive headers in production,
- consider adding request size limits and upstream allowlists.

---

## License

Add your project license here, for example:

```text
MIT
```


services:
  serverjsonata:
    build: .
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      ENDPOINTS_CONFIG_PATH: /app/config/endpoints.json
      FORWARD_HEADERS: cookie,authorization,accept-language,x-request-id
    volumes:
      - ./endpoints.json:/app/config/endpoints.json:ro