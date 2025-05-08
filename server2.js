// server2.js
fetch = require('cross-fetch');
global.fetch = global.fetch || fetch;

const { stitchSchemas } = require('@graphql-tools/stitch');
const { loadSchema } = require('@graphql-tools/load');
const { UrlLoader } = require('@graphql-tools/url-loader');
const { wrapSchema } = require('@graphql-tools/wrap');

const express = require('express');
const { printSchema } = require('graphql');
const { makeExecutableSchema, mergeTypeDefs } = require('@graphql-tools/schema');


async function buildSupergraph(subgraphs) {
  // 1) Load and wrap each subgraph
  const subschemas = await Promise.all(
      subgraphs.map(async ({ name, url }) => {
        // load the remote schema via UrlLoader
        console.log('→ Introspecting', url);
        const remoteSchema = await loadSchema(url, {
            loaders: [ 
                new UrlLoader({ 
                    useGETForQueries: false,
                    customFetch: (endpoint, opts) => {
                        console.log(`🔍 Introspection POST to ${endpoint}:\n${opts.body}\n`);
                        return fetch(endpoint, opts);
                    },
                    useURLLoaderVariants: false,
                }) 
            ]
        });
        console.log('✅ Got schema for', url);
        // wrap it so you can still delegate
        const wrapped = wrapSchema({
            schema: remoteSchema,
            executor: async ({ document, variables }) => {
                const query = print(document);

                // copy all incoming headers except maybe host/connection
                const forwardHeaders = { ...context.headers };
                // ensure content‑type is JSON
                forwardHeaders['Content-Type'] = 'application/json';
            
                const body = JSON.stringify({ query, variables }); 
                const res = await fetch(url, {
                  method: 'POST',
                  headers: forwardHeaders,
                  body: body,
                });
                console.log(body)
                return res.json();
            }
        });
      return {
        schema: wrapped,
        merge: {
          // you can define merge config here if you want @key‑style merging,
          // or let it default to “namespace every subgraph”…
        }
      }
    })
  )

  // 2) Stitch them together
  const supergraph = stitchSchemas({
    subschemas,
    // THIS FLAG PRESERVES ALL DIRECTIVES AND THEIR USAGES
    mergeDirectives: true,
  })

  return supergraph
}

const getENV = (name, defaultValue) => {
    const value = process.env[name];
  
    if (typeof value === "undefined") {
      if (typeof defaultValue === "undefined") {
        throw new Error(`Missing environment variable '${name}'`);
      }
      return defaultValue;
    }
  
    return value;
};

const readConfig = () => {
    // const rawdata = fs.readFileSync('config.json');

    const rawdata = getENV("SERVICES", "[]");
    let config = JSON.parse(rawdata);

    console.log(config)
    if (config.length === 0) {
        console.log("******************************************************************")
        console.log("**            Missing SERVICES env ??                           **")
        console.log("******************************************************************")
        console.log("**                                                              **")
        console.log("**                                                              **")
        console.log("**services:                                                     **")
        console.log("**  apollo:                                                     **")
        console.log("**    image: hrbolek/apollo_federation                          **")
        console.log("**    environment:                                              **")
        console.log("**      - PORT=3000                                             **")
        console.log("**      - |                                                     **")
        console.log("**        SERVICES=                                             **")
        console.log("**        [                                                     **")
        console.log('**          {"name": "ug", "url": "http://gql_ug:8000/gql"}     **')
        console.log("**        ]                                                     **")
        console.log("******************************************************************")
    }
    return config
}

async function start() {
//   const subgraphs = [
//     { name:'users', url:'http://localhost:4001/graphql' },
//     { name:'orders', url:'http://localhost:4002/graphql' },
//     // …etc
//   ]

  const subgraphs = readConfig()

  const supergraph_schema = await buildSupergraph(subgraphs)

  // 1) Rozšíříme Query o federovanou část
  const schemaWithService = stitchSchemas({
    subschemas: [ { schema: supergraph_schema } ],
    typeDefs: gql`
      """
      Standard field for federation SDL introspection
      """
      extend type Query {
        _service: _Service!
      }
      """Result of _service.sdl"""
      type _Service {
        sdl: String!
      }
    `,
    resolvers: {
      Query: {
        _service: () => ({})
      },
      _Service: {
        sdl: () => printSchema(supergraph)  // nebo print(supergraph)
      }
    }
  })

  const app = express()
//   app.use('/api/gql', graphqlHTTP({ schema, graphiql:true }))

  // --- 3) Tady se nasazuje GraphQL endpoint ---
  app.use(
    '/api/gql',
    graphqlHTTP({
      schema: schemaWithService,
      graphiql: true,            // nebo false, chcete‑li vypnout GraphiQL
      context: { headers: req.headers },
      customFormatErrorFn: (err) => ({
        message: err.message,
        locations: err.locations,
        path: err.path,
      }),
    })
  );

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('🚀 supergraph on http://localhost:3000/api/gql'))
}

start()
