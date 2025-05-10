const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer } = require('@apollo/server/standalone');
const { ApolloGateway, RemoteGraphQLDataSource } = require('@apollo/gateway');
const { composeAndValidate } = require('@apollo/federation');
const { parse } = require('graphql');
const { gql } = require('graphql-tag');
const fetch = require('cross-fetch');

// ——————————————————————————————————————————————————————————————————
// 1) Parse & validate SERVICES
// ——————————————————————————————————————————————————————————————————
let subgraphsConfig;
try {
  subgraphsConfig = JSON.parse(process.env.SERVICES || '[]');
  if (!Array.isArray(subgraphsConfig) || subgraphsConfig.length === 0) {
    throw new Error('SERVICES must be a non‑empty JSON array');
  }
  for (const svc of subgraphsConfig) {
    if (typeof svc.name !== 'string' || typeof svc.url !== 'string') {
      throw new Error(
        `Each service must have a "name" and a "url". Invalid entry: ${JSON.stringify(svc)}`
      );
    }
  }
  console.log('🔍 Federation subgraphs:', subgraphsConfig);
} catch (err) {
  console.error('❌ Invalid SERVICES env var:', err.message);
  process.exit(1);
}

// ——————————————————————————————————————————————————————————————————
// 2) Fetch each sub‑graph’s _service.sdl and compose the supergraph SDL
// ——————————————————————————————————————————————————————————————————
async function buildSupergraphSdl() {
  const services = await Promise.all(
    subgraphsConfig.map(async ({ name, url }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ _service { sdl } }' })
      });
      const { data, errors } = await res.json();
      if (errors) {
        throw new Error(`Error fetching SDL from ${name}@${url}: ${JSON.stringify(errors)}`);
      }
      return { name, typeDefs: parse(data._service.sdl) };
    })
  );

  const { errors, supergraphSdl } = composeAndValidate(
    services.map(s => ({ name: s.name, typeDefs: s.typeDefs }))
  );
  if (errors && errors.length > 0) {
    console.error('❌ Federation composition errors:', errors);
    process.exit(1);
  }

  return supergraphSdl;
}

// ——————————————————————————————————————————————————————————————————
// 3) Start the federated gateway with exposed _service.sdl
// ——————————————————————————————————————————————————————————————————
async function startGateway() {
  const supergraphSdl = await buildSupergraphSdl();

  const gateway = new ApolloGateway({
    supergraphSdl,
    serviceList: subgraphsConfig,
    buildService({ url }) {
      return new RemoteGraphQLDataSource({
        url,
        willSendRequest({ request, context }) {
          if (context.headers) {
            for (const [k, v] of Object.entries(context.headers)) {
              request.http.headers.set(k, v);
            }
          }
        }
      });
    }
  });

  const server = new ApolloServer({
    gateway,
    introspection: true,
    typeDefs: gql`
      extend type Query {
        _service: _Service!
      }

      type _Service {
        sdl: String
      }
    `,
    resolvers: {
      Query: {
        _service: () => ({})
      },
      _Service: {
        sdl: () => supergraphSdl
      }
    }
  });

  const { url } = await startStandaloneServer(server, {
    listen: { port: process.env.PORT || 3000 },
    context: async ({ req }) => ({
      headers: req.headers
    })
  });

  console.log(`🚀 Federation v2 gateway ready at ${url}`);
  console.log(`📡 Try { _service { sdl } } to see the composed SDL`);
}

startGateway().catch(err => {
  console.error('❌ Gateway failed to start:', err);
  process.exit(1);
});
