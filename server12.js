const express                = require('express');
const { gql } = require('graphql-tag');
const { json }               = require('body-parser');
const { ApolloServer }       = require('@apollo/server');
const { expressMiddleware }  = require('@apollo/server/express4');

const { stitchSchemas }      = require('@graphql-tools/stitch');
const { wrapSchema, FilterRootFields }         = require('@graphql-tools/wrap');
const { parse, print, printSchema, Kind } = require('graphql');
const { buildSubgraphSchema }        = require('@apollo/subgraph');
const fetch                  = require('cross-fetch');

/**
 * Merge field‑level directives from each subgraph AST into the gateway AST.
 * Also pull in any directive definitions that the gateway is missing.
 */
function mergeDirectives(gatewaySDL, subgraphSDLs) {
    // 1) Parse everything
    const gatewayAST  = parse(gatewaySDL);
    const subASTs     = subgraphSDLs.map(sdl => parse(sdl));
  
    // 2) Build a map of directive definitions from subschemas
    const directiveDefs = new Map();
    subASTs.forEach(ast => {
      for (const def of ast.definitions) {
        if (def.kind === Kind.DIRECTIVE_DEFINITION) {
          directiveDefs.set(def.name.value, def);
        }
      }
    });
  
    // 3) Build a map: typeName → fieldName → [DirectiveNode,...]
    const subFieldDirectives = new Map();
    subASTs.forEach(ast => {
      for (const def of ast.definitions) {
        if (
          def.kind === Kind.OBJECT_TYPE_DEFINITION ||
          def.kind === Kind.INTERFACE_TYPE_DEFINITION
        ) {
          const typeMap = subFieldDirectives.get(def.name.value) || new Map();
          def.fields.forEach(field => {
            if (field.directives && field.directives.length) {
              typeMap.set(field.name.value, field.directives);
            }
          });
          subFieldDirectives.set(def.name.value, typeMap);
        }
      }
    });
  
    // 4) Walk the gateway AST and attach subgraph directives
    const newDefinitions = [];
    for (const def of gatewayAST.definitions) {
      // If it’s an object or interface, we may have subgraph directives
      if (
        (def.kind === Kind.OBJECT_TYPE_DEFINITION ||
         def.kind === Kind.INTERFACE_TYPE_DEFINITION) &&
        def.fields
      ) {
        const typeName = def.name.value;
        const fieldMap = subFieldDirectives.get(typeName);
        if (fieldMap) {
          const newFields = def.fields.map(field => {
            const extraDirs = fieldMap.get(field.name.value) || [];
            // merge without duplicates
            const merged = [
              ...field.directives || [],
              ...extraDirs.filter(d =>
                !((field.directives||[]).some(existing => existing.name.value === d.name.value))
              )
            ];
            return { ...field, directives: merged };
          });
          newDefinitions.push({ ...def, fields: newFields });
          continue;
        }
      }
      // otherwise keep definition as is
      newDefinitions.push(def);
    }
  
    // 5) Pull in any missing directive definitions
    // first collect names in gateway
    const existingDirNames = new Set();
    gatewayAST.definitions.forEach(def => {
      if (def.kind === Kind.DIRECTIVE_DEFINITION) {
        existingDirNames.add(def.name.value);
      }
    });
    for (const [name, dirDef] of directiveDefs) {
      if (!existingDirNames.has(name)) {
        newDefinitions.unshift(dirDef);
      }
    }
  
    // 6) Produce a new merged AST and print it
    const mergedAST = { ...gatewayAST, definitions: newDefinitions };
    return print(mergedAST);
}
  

// pomocná funkce, která pro URL subgraphu fetchne jeho SDL
async function fetchSubgraphSDL(url, headers) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: '{ _service { sdl } }' })
    });
    const { data, errors } = await resp.json();
    if (errors) {
      throw new Error(`Failed to fetch SDL from ${url}: ${JSON.stringify(errors)}`);
    }
    return data._service.sdl;
}



// 2) add a local _Service type + Query._service override
const supergraphTypeDefs = gql`
 extend type Query {
   _service: _Service!
 }
 type _Service {
   sdl: String!
 }
`;

const supergraphResolvers = {
    Query: {
        _service() {
            // resolver must return an object so that _Service.sdl can fire
            return {};
        }
    },
    _Service: {
        async sdl(parent, args, context, info) {
            const services = JSON.parse(process.env.SERVICES || '[]');
            // re-fetch each subgraph’s SDL, passing along client headers
            const subSDLs = await Promise.all(
            services.map(svc => fetchSubgraphSDL(svc.url, context.headers))
            );
            // print the stitched schema as the “gateway SDL”…
            const gatewaySDL = printSchema(info.schema);
            // …and merge in all field-level directives
            return mergeDirectives(gatewaySDL, subSDLs);
        }
    }
};

async function buildGatewaySchema(services) {
  const subschemas = await Promise.all(
    services.map(async ({ name, url }) => {
      //
      // 1) fetch the _service.sdl from this subgraph
      //
      const sdlQuery = `query { _service { sdl } }`;
      const sdlResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sdlQuery })
      });
      const sdlJson = await sdlResp.json();
      if (sdlJson.errors) {
        throw new Error(
          `Error fetching SDL from ${name}@${url}: ${JSON.stringify(sdlJson.errors)}`
        );
      }
      const sdl = sdlJson.data._service.sdl;

      //
      // 2) parse the SDL into an AST and build a real GraphQLSchema
      //
      const ast          = parse(sdl);
      const remoteSchema = buildSubgraphSchema(ast);

      //
      // 3) wrap it so stitching can delegate, forwarding inbound headers
      //
      const executor = async ({ document, variables, context }) => {
        const query = print(document);
        const res   = await fetch(url, {
          method: 'POST',
          headers: {
            ...context.headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query, variables })
        });
        console.log(`Asking ${url} for\n${query}\nwith\n${JSON.stringify(variables)}`)
        return res.json();
      };

      const wrapped = wrapSchema({
        schema:   remoteSchema,
        executor,
        transforms: [
            new FilterRootFields((operation, fieldName) =>
              // keep everything except Query._service
              !(operation === 'Query' && fieldName === '_service')
            )
        ]
      });

      return {
        schema: wrapped
        // you can add per‑type merge configs here if you like
      };
    })
  );

  //
  // 4) stitch all the wrapped subgraphs together with override
  //
  return stitchSchemas({
    subschemas,
    typeDefs: [supergraphTypeDefs],
    resolvers: supergraphResolvers,
    mergeDirectives: true,  // keep all directive definitions & usages
    // plus any local typeDefs/resolvers, e.g. _service.sdl for your gateway
  });

}

async function start() {
  const services      = JSON.parse(process.env.SERVICES || '[]');
  const gatewaySchema = await buildGatewaySchema(services);

  const server = new ApolloServer({ schema: gatewaySchema });
  await server.start();

  const app = express();
  app.use(json());

  // serve SDL at /api/gql/sdl
  app.get('/api/gql/sdl', async (req, res) => {
    try {
  
        // stáhneme SDL od všech subgraphů (s originálními hlavičkami z klienta)
        const subSDLs = await Promise.all(
          services.map(s => fetchSubgraphSDL(s.url, req.headers))
        );
  
        // sloučíme a injektujeme field‑level diretivy
        const finalSDL = mergeDirectives(printSchema(gatewaySchema), subSDLs);
  
        res.type('text/plain').send(finalSDL);
      } catch (err) {
        console.error('Error generating merged SDL', err);
        res.status(500).send(err.message);
      }
  });

  app.use(
    '/api/gql',
    expressMiddleware(server, {
      context: async ({ req }) => ({ headers: req.headers })
    })
  );

  app.listen(3000, () =>
    console.log('🚀 Federated gateway on http://localhost:3000/api/gql')
  );
}

start().catch(console.error);
