// server2.js
const express           = require('express');
const { json }          = require('body-parser');
const fetch             = require('cross-fetch');
const gql               = require('graphql-tag');
const {
  parse,
  print,
  printSchema,
  buildASTSchema,
} = require('graphql');
const { ApolloServer }      = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');

const { stitchSchemas }            = require('@graphql-tools/stitch');
const { wrapSchema }               = require('@graphql-tools/wrap');
const { extractFederationDefinitions } = require('@graphql-tools/federation');

async function buildSupergraph(subgraphs) {
  // 1) Pull down each subgraph’s SDL via _service.sdl
  const wrappedSubschemas = await Promise.all(
    subgraphs.map(async ({ name, url }) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ query: `{ _service { sdl } }` })
      });
      const { data, errors } = await resp.json();
      if (errors) throw errors;
      const ast    = parse(data._service.sdl);
      const schema = buildASTSchema(ast);

      // 2) Wrap for delegation (forward headers)
      const wrapped = wrapSchema({
        schema,
        executor: async ({ document, variables, context }) => {
          const queryString = print(document);
          const result = await fetch(url, {
            method: 'POST',
            headers: { ...context.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: queryString, variables })
          });
          return result.json();
        }
      });

      return wrapped;
    })
  );

  // 3) Use extractFederationDefinitions to wire up @key/@external automatically
  const federationTypeDefs = extractFederationDefinitions(
    wrappedSubschemas.map(s => s.toConfig().astNode)
  );

  // 4) Stitch all together
  return stitchSchemas({
    subschemas: wrappedSubschemas.map(schema => ({ schema })),
    typeDefs:   [federationTypeDefs],
    mergeDirectives: true,
  });
}

async function start() {
  const subgraphs = JSON.parse(process.env.SERVICES || '[]');
  const supergraph = await buildSupergraph(subgraphs);

  // Re‑expose _service.sdl on the gateway
  const gatewaySchema = stitchSchemas({
    subschemas: [{ schema: supergraph }],
    typeDefs: gql`
      extend type Query { _service: _Service! }
      type _Service { sdl: String! }
    `,
    resolvers: {
      Query:    { _service: () => ({}) },
      _Service: { sdl: () => printSchema(supergraph) },
    }
  });

  const server = new ApolloServer({ schema: gatewaySchema });
  await server.start();

  const app = express();
  app.use(json());
  app.use(
    '/api/gql',
    expressMiddleware(server, {
      context: async ({ req }) => ({ headers: req.headers })
    })
  );

  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.log(`🚀 Supergraph up at http://localhost:${port}/api/gql`)
  );
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});
