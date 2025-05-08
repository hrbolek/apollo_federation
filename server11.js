const express          = require('express');
const { json }         = require('body-parser');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');

const { stitchSchemas }    = require('@graphql-tools/stitch');
const { wrapSchema, introspectSchema } = require('@graphql-tools/wrap');
const { print }            = require('graphql');
const fetch                = require('cross-fetch'); // or node-fetch

const { loadSchema }  = require('@graphql-tools/load');
const { UrlLoader }   = require('@graphql-tools/url-loader');

async function buildGatewaySchema(services) {
  // services = [ { name:"users", url:"http://users:4001/graphql" }, … ]
  const subschemas = await Promise.all(
    services.map(async ({ name, url }) => {
      // 1) Create an executor that knows how to call THIS subgraph
      const executor = async ({ document, variables, context }) => {
        const query = print(document);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            ...context.headers,            // ← forward the inbound headers
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query, variables })
        });
        console.log(`query ${name} at ${url} for \n${query}\nwith\n${JSON.stringify(variables)}`)
        return res.json();
      };

      // 1) get the remote schema via loadSchema
      const remoteSchema = await loadSchema(url, {
        loaders: [ new UrlLoader({ fetch }) ]
      });

      // 2) wrap it so stitchSchemas can delegate
      const wrapped = wrapSchema({
        schema:   remoteSchema,
        executor: executor
      });

      return { schema: wrapped };
    })
  );

  // 4) Stitch them all into one supergraph
  return stitchSchemas({
    subschemas,
    mergeDirectives: true,  // preserve your @directives
    // …any local typeDefs/resolvers (e.g. _service.sdl)
  });
}

async function start() {
  const services = JSON.parse(process.env.SERVICES || '[]');
  const gatewaySchema = await buildGatewaySchema(services);

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

  app.listen(3000, () => {
    console.log('🚀 Federated gateway on http://localhost:3000/api/gql');
  });
}

start().catch(console.error);
