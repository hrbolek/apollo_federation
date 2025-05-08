const express               = require('express');
const { json }              = require('body-parser');
const { ApolloServer }      = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');

const {
  stitchSchemas,
  printSchema,
} = require('@graphql-tools/stitch');
const { wrapSchema }        = require('@graphql-tools/wrap');
const { parse, print, buildASTSchema } = require('graphql');
const fetch                 = require('cross-fetch');

const { Kind } = require('graphql');

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
  


async function buildGatewaySchema(services) {
  // 1) Fetch all subgraph SDLs and build wrapped subschemas
  const subgraphSDLs = [];
  const subschemas = await Promise.all(
    services.map(async ({ name, url }) => {
      // 1a) Fetch the SDL
      const { data, errors } = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ query: '{ _service { sdl } }' })
      }).then(r => r.json());
      if (errors) throw new Error(`Failed to fetch SDL from ${name}: ${JSON.stringify(errors)}`);
      const sdl = data._service.sdl;
      subgraphSDLs.push(sdl);

      // 1b) Parse + build a real schema (preserving federation directives via buildASTSchema or buildSubgraphSchema)
      const ast          = parse(sdl);
      const remoteSchema = buildASTSchema(ast); // or buildSubgraphSchema(ast) if you need @key/@external defs

      // 1c) Wrap for delegation + header‑forwarding
      const executor = async ({ document, variables, context }) => {
        const query = print(document);
        return fetch(url, {
          method: 'POST',
          headers: { 
            ...context.headers, 
            'Content-Type':'application/json' 
          },
          body: JSON.stringify({ query, variables })
        }).then(r => r.json());
      };
      const wrapped = wrapSchema({ schema: remoteSchema, executor });
      return { schema: wrapped };
    })
  );

  // 2) Stitch them into a first‑cut gateway
  const initialGateway = stitchSchemas({
    subschemas,
    mergeDirectives: true, 
  });

  // 3) Print that gateway to SDL
  const gatewaySDL = printSchema(initialGateway);

  // 4) Run your mergeDirectives to inject **all** field‐level usages and any missing defs
  const fullyMergedSDL = mergeDirectives(gatewaySDL, subgraphSDLs);

  // 5) Re‑parse into a new GraphQLSchema
  const finalAST    = parse(fullyMergedSDL);
  const finalSchema = buildASTSchema(finalAST);

  return finalSchema;
}

async function start() {
  const services      = JSON.parse(process.env.SERVICES || '[]');
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

  app.listen(3000, () =>
    console.log('🚀 Federated gateway on http://localhost:3000/api/gql')
  );
}

start().catch(console.error);
