// server2.js
const express = require('express');
const { json } = require('body-parser');
const { stitchSchemas } = require('@graphql-tools/stitch');
const { wrapSchema }    = require('@graphql-tools/wrap');
const fetch             = require('cross-fetch');
const gql               = require('graphql-tag');
const {
  parse,
  print,
  printSchema,
  buildASTSchema,
} = require('graphql');

// Apollo Server 4
const { ApolloServer }       = require('@apollo/server');
const { expressMiddleware }  = require('@apollo/server/express4');

async function buildSupergraph(subgraphs) {
  const subschemas = await Promise.all(
    subgraphs.map(async ({ name, url }) => {
      // 1) získáme raw SDL z federace
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `{ _service { sdl } }` }),
      });
      const { data, errors } = await resp.json();
      if (errors) throw new Error(`SDL fetch error ${name}: ${errors}`);
      const ast    = parse(data._service.sdl);
      const schema = buildASTSchema(ast);

      // 2) obalíme pro delegaci
      const wrapped = wrapSchema({
        schema,
        executor: async ({ document, variables, context }) => {
          const queryString = print(document);
          const result = await fetch(url, {
            method: 'POST',
            headers: {
              ...context.headers,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query: queryString, variables })
          });
          return result.json();
        }
      });

      return { schema: wrapped, merge: {} };
    })
  );

  return stitchSchemas({ subschemas, mergeDirectives: true });
}

async function start() {
  const subgraphs = JSON.parse(process.env.SERVICES || '[]');
  const supergraph = await buildSupergraph(subgraphs);

  // přidáme federované _service.sdl
  const gatewaySchema = stitchSchemas({
    subschemas: [{ schema: supergraph }],
    typeDefs: gql`
      extend type Query { _service: _Service! }
      type _Service { sdl: String! }
    `,
    resolvers: {
      Query: { _service: () => ({}) },
      _Service: { sdl: () => printSchema(supergraph) },
    },
  });

  // 3) ApolloServer v4
  const server = new ApolloServer({
    schema: gatewaySchema,
  });
  await server.start();

  const app = express();
  app.use(json());
  // 4) middleware s forwardem headers
  app.use(
    '/api/gql',
    expressMiddleware(server, {
      context: async ({ req }) => ({ headers: req.headers }),
    })
  );

  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.log(`🚀 Supergraph running at http://localhost:${port}/api/gql`)
  );
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});
