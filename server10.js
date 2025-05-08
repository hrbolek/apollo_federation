//const { ApolloServer } = require("apollo-server");
const fetch = require('cross-fetch');
const { json, OptionsJson } = require('body-parser');
const { ApolloServer, gql } = require("apollo-server-express");
const { parse, printSchema, print, buildASTSchema, Kind, buildSchema } = require('graphql');
const { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } = require("@apollo/gateway");
const { stitchSchemas }    = require('@graphql-tools/stitch');
const { wrapSchema } = require('@graphql-tools/wrap');


const express = require('express')
//const http = require('http')

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

// const fs = require('fs');

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

/**
 * Fetch raw SDL from a federated subgraph via its _service.sdl endpoint.
 */
async function fetchSubgraphSDL(url, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query __ApolloGetServiceDefinition__ { _service { sdl } }` })
  });
  const { data, errors } = await res.json();
  if (errors) throw new Error(`Error fetching SDL from ${url}: ${errors}`);
  return data._service.sdl;
}


const sdlResolver = async (supergraphSdl, services, headers) => {
  const subSDLs  = await Promise.all(
    services.map(s => fetchSubgraphSDL(s.url))
  );
  // 3) Merge
  const finalSDL = mergeDirectives(supergraphSdl, subSDLs);  
  return finalSDL
}

async function startApolloServer(config) {
  const gateway = new ApolloGateway({
    supergraphSdl: new IntrospectAndCompose({
      subgraphs: config,
    }),
    /*
    context: ({ req }) => {
      // toto zjevne neni volano v prubehu dotazu
      console.log('called context function')
      return {
        serverRequest: req,
      };
    },
    //*/
    buildService({ name, url }) {
      console.log("build service", name, url)
      return new RemoteGraphQLDataSource({
        url,
        willSendRequest(params) {
          //*
          const { request, context, incomingRequestContext } = params
          console.log('params')
          console.log(JSON.stringify(Object.keys(params)))
          console.log('context')
          console.log(JSON.stringify(Object.keys(context)))

          if (incomingRequestContext) {
              // console.log('incomingRequestContext')
              // console.log(JSON.stringify(Object.keys(incomingRequestContext)))

              const incRequest = incomingRequestContext.request
              // console.log(JSON.stringify(Object.keys(incRequest)))

              const headers = incRequest.http.headers
              // console.log('headers: ' + headers)
              // console.log(headers)
              const authHeaderValue = headers.get('Authorization')
              // console.log('authHeaderValue: ' + authHeaderValue)
              for (const headerItem of headers) {
                  //toto funguje
                  // console.log('header item: ' + headerItem)
                  // console.log('header item type: ' + (typeof headerItem))
                  // console.log('header item: ' + JSON.stringify(headerItem))
                  // console.log('header item methods: ' + JSON.stringify(Object.keys(headerItem)))
                  if (headerItem[0].startsWith('Authorization')) {
                    const [key, value] = headerItem.split(' ')
                    request.http?.headers.set(key, String(value));
                  }
                  if (headerItem[0].startsWith('authorization')) {
                    const [key, value] = headerItem.split(' ')
                    request.http?.headers.set(key, String(value));
                  }
                  if (headerItem[0].startsWith('cookie')) {
                    request.http?.headers.set(headerItem[0], headerItem[1]);
                  }

              }
              console.log("final headers")
              console.log(request.http?.headers)
              console.log(JSON.stringify(request.http?.headers))
      }

          //console.log(JSON.stringify(Object.keys(request)))
          //console.log(JSON.stringify(Object.keys(request.http)))
          console.log('request for ', JSON.stringify(request.http.url))
          if (request.query) { console.log(JSON.stringify(request.query)) }
          if (request.variables) { console.log(JSON.stringify(request.variables)) }
          if (request.operationName) { console.log(JSON.stringify(request.operationName)) }

          //console.log(JSON.stringify(request.context))
          //console.log(JSON.stringify(typeof context))

          //const headers = context.req.headers
          /*
          for (const key in headers) {
              const value = headers[key];
              if (value) {
                  request.http?.headers.set(key, String(value));
              }
          }
          //request.http.headers.set("Authorization", "Bearer ABCDE");
          //*/

          request.http.timeout = 5 * 60
        }
      });
    }
  })

  if (false) {
    await gateway.load();  // populates gateway.supergraphSdl

    // 2) Turn that SDL into a GraphQLSchema
    const supergraphSdl = gateway.supergraphSdl;
    // const supergraphSdlString = printSchema(supergraphSdl);
    const supergraphAst = parse(supergraphSdl);
    const supergraphSchema = buildASTSchema(supergraphAst);
  
  


    // const wrappedSupegraphSchema = wrapSchema({
    //   schema: supergraphSchema,
    //   executor: async ({ document, variables, context }) => {
    //     const query = print(document);
    //     return fetch(url, {
    //       method: 'POST',
    //       headers: {
    //         ...context.headers,               // <— your incoming req headers
    //         'Content-Type': 'application/json'
    //       },
    //       body: JSON.stringify({ query, variables }),
    //     }).then(r => r.json());
    //   }
    // });


    // 3) Stitch in your dummy _service.sdl field
    const gatewaySchema = stitchSchemas({
      subschemas: [{ schema: supergraphSchema }],
      typeDefs: gql`
        extend type Query {
          _service: _Service!
        }
        type _Service {
          sdl: String!
        }
      `,
      resolvers: {
        Query: {
          _service: () => ({})
        },
        _Service: {
          sdl: async (_parent, _args, { headers }) => {
            return await sdlResolver(supergraphSdl, config, headers)
          }  // ← swap in real SDL if/when ready
        }
      },
      mergeDirectives: true
    });

  }

  const app = express();
  //const httpServer = http.createServer(app);

  //
  // Another possibility
  //
  // const { ApolloServer } = require('@apollo/server');
  // const { ApolloGateway } = require('@apollo/gateway');
  
  // const myExtensionModule = {
  //   typeDefs: gql`
  //     extend type Query {
  //       _service: _Service!
  //     }
  //     type _Service { sdl: String! }
  //   `,
  //   resolvers: {
  //     Query: { _service: () => ({}) },
  //     _Service: {
  //       sdl: async (_parent, _args, { headers }) => {
  //         return await sdlResolver(supergraphSdl, config, headers)
  //       }  // ← swap in real SDL if/when ready
  //     }
  //   }
  // };
  
  // const gateway = new ApolloGateway({ /* … */ });
  
  // const server = new ApolloServer({
  //   gateway,
  //   modules: [ myExtensionModule ]
  // });

  const server = new ApolloServer({ 
    // schema: gatewaySchema,
    // schema: supergraphSchema,
    gateway: gateway, //gateway nebo schema
    // modules: [myExtensionModule], //
    context: ({ req }) => {
      // now every resolver (and every wrapSchema executor) sees `context.headers`
      return { headers: req.headers, req };
    }
  });
  

  console.log('server pre start')
  await server.start()
  console.log('server post start')

  // app.use((req, res, next) => {
  //   console.log('Request Type A:', req.method, req.body)
  //   next()
  // })

  app.use(json())

  app.use((req, res, next) => {
    console.log('Request Type A2:', req.method, req.body)
    next()
  })
  
  server.applyMiddleware({ 
    app, 
    path: '/api/gql', 
    cors: false, 
    bodyParserConfig: false ,
    context: ({ req }) => {
      // whatever you return here is the "context" in your resolvers
      return { headers: req.headers };
    }    
  });

  // Přidáme samostatný Express endpoint pro získání SDL
  app.get("/sdl", async (req, res) => {
    console.log('Received request on /sdl');
    try {
      // Pokud ještě nemáme SDL, můžeme volat load(), jinak stačí použít existující hodnotu.
      if (!gateway.supergraphSdl) {
        await gateway.load();
      }
      const supergraphSdl = gateway.supergraphSdl || "SDL not available";

      const services = readConfig()
      const subSDLs  = await Promise.all(
        services.map(s => fetchSubgraphSDL(s.url))
      );
      // 3) Merge
      const finalSDL = mergeDirectives(supergraphSdl, subSDLs);  
      
    
      console.log('Returning SDL: ', finalSDL);
      res.type("text/plain").send(finalSDL);
    } catch (e) {
      console.error('Error loading gateway SDL', e);
      res.status(500).send("Error loading SDL");
    }
  });


  const PORT = getENV("PORT", "3000");

  // app.use((req, res, next) => {
  //   console.log('Request Type B:', req.method, req.body)
  //   next()
  // })

  app.listen(PORT, () => {
    console.log(`🚀 Server ready at ${PORT}`);
  });

}

const config = readConfig();
startApolloServer(config);
