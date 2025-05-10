//const { ApolloServer } = require("apollo-server");
const { json, OptionsJson } = require('body-parser');
const { ApolloServer } = require("apollo-server-express");

const { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } = require("@apollo/gateway");

const express = require('express')
//const http = require('http')

const { ApolloServer: ApolloServerSDL } = require('@apollo/server');
const { gql } = require('graphql-tag');

const { expressMiddleware } = require('@apollo/server/express4');
const { parse, print, Kind } = require('graphql');
const fetch = require('cross-fetch');

const { stitchSchemas } = require('@graphql-tools/stitch');
const { wrapSchema }        = require('@graphql-tools/wrap');
const { Executor } = require('@graphql-tools/utils');
const { ApolloServer: ApolloStitchServer } = require('@apollo/server');
const { createServer } = require('node:http');
const { urlLoaderExecutor } = require('@graphql-tools/url-loader');

const { getIntrospectionQuery, buildClientSchema } = require('graphql');


/*
prompt pro AI
# 🧠 Zadání: GraphQL Gateway Server pro správu federace

## 🎯 Cíl
Potřebuji vytvořit kompletní server pro správu federované GraphQL infrastruktury (Apollo Federation v2) s následující architekturou a funkcemi:

---

## 🔌 Endpointy

### 1. `/api/apollo` – Federovaný gateway
- Implementace pomocí `ApolloGateway` a `IntrospectAndCompose` (Apollo Federation v2).
- Forwardování hlaviček (`Authorization`, `Cookie`, apod.) do subgrafů pomocí `RemoteGraphQLDataSource`.
- Slouží jako backend pro dotazy a `resolveReference`.

### 2. `/sdl` – SDL-only GraphQL server
- Vrací výstup `{ _service { sdl } }`.
- SDL pochází z `gateway.supergraphSdl` a je doplněno o direktivy pomocí `mergeDirectives(...)`.
- Při získávání `_service.sdl` ze subgrafů přeposílá hlavičky z klienta dál.

### 3. `/api/sdl` – Stitching server
- Používá `@graphql-tools/stitch` pro sjednocení `/api/apollo` + `/sdl`.
- Schéma obsahuje jak datové resolvery, tak SDL s direktivami.
- Přeposílá hlavičky do obou podřízených endpointů.

---

## ✅ Požadavky

- Použít moderní balíčky:  
  - `@apollo/server`, `@apollo/gateway`, `@graphql-tools/stitch`
- Hlavičky se musí přenášet všude, včetně do `fetch()` v SDL-only resolveru
- Direktivy ze subgrafů musí být součástí výsledného SDL (`mergeDirectives`)
- Vše běží v rámci jednoho `Express` serveru

---

## 🧪 Nepovinné doplňky (pokud je přidám do zadání)

- [ ] Endpoint `/sdl.txt` vrací SDL jako `text/plain`
- [ ] Při startu se SDL uloží do `sdl.graphql` (soubor)
- [ ] Všechny funkce budou mít JSDoc komentáře
- [ ] Připravit jednoduché testy (např. `supertest` nebo `jest`)

---

## 📦 Výstup
- Jeden funkční JS/TS soubor (nebo projekt), který vše propojuje
- Jasně pojmenované funkce: `startApolloServer()`, `startSDLServer()`, `startStitchedSdlServer()`, atd.
- Vše připraveno pro Docker nebo lokální běh

*/



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

const PORT = getENV("PORT", "3000");
const APIGQL = '/api/gql'
const APISDL = '/api/sdl'
const APISDLOnly = '/sdl'
const APIRAWFEDERATION = '/api/apollo'


/* Provede introspekci GraphQL schématu přes executor (např. fetch).
*
* @param {Function} executor - Executor, který vykonává GraphQL dotazy.
* @returns {Promise<import('graphql').GraphQLSchema>} - Vytvořené GraphQL schéma.
*/
async function introspectSchema(executor) {
  const introspectionQuery = getIntrospectionQuery();
  const result = await executor({
    document: introspectionQuery,
    variables: {},
    context: {}
  });
  if (result.errors) {
    throw new Error(`Introspection failed: ${JSON.stringify(result.errors)}`);
  }
  return buildClientSchema(result.data);
}


async function createRemoteWrappedSchema(executor) {
  const schema = await introspectSchema(executor);
  return wrapSchema({ schema, executor });
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
 * Vytvoří GraphQL executor pro vzdálený GraphQL endpoint.
 *
 * Tento executor je kompatibilní s `@graphql-tools` a používá `fetch`
 * k přeposílání GraphQL dotazů na zadanou URL.
 * Automaticky přeposílá hlavičky z contextu (např. pro autorizaci).
 *
 * @param {string} uri - URL vzdáleného GraphQL serveru (např. 'http://localhost:4000/graphql').
 * @returns {function} Executor funkce kompatibilní s `@graphql-tools`, která vykonává GraphQL operace.
 *
 * @example
 * const executor = createRemoteExecutor('http://localhost:4000/graphql');
 * const result = await executor({
 *   document: parse('{ hello }'),
 *   variables: {},
 *   context: { headers: { Authorization: 'Bearer xyz' } }
 * });
 */
function createRemoteExecutor(uri) {
  return async ({ document, variables, context }) => {
    const query = typeof document === 'string' ? document : print(document);
    const headers = context?.headers || {};
    const res = await fetch(uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  };
}

/**
 * Spustí GraphQL stitching server, který sjednocuje dva vzdálené GraphQL endpointy
 * do jednoho sloučeného schématu. Výsledné schéma je dostupné přes zadanou cestu (`finalendpoint`).
 *
 * Server používá `wrapSchema` a `stitchSchemas` z `@graphql-tools` pro kombinaci:
 * - federovaného Apollo serveru (např. `/api/gql`)
 * - SDL-only serveru (např. `/sdl`), který poskytuje složené SDL s direktivami
 *
 * Při každém dotazu předává HTTP hlavičky dál do sub-schema resolverů.
 *
 * @param {import('express').Express} app - Express aplikace, ke které se stitching server připojí jako middleware.
 * @param {string[]} [sourceendpoints] - Dvojice endpointů ve tvaru `[apolloFederationUrl, sdlProviderUrl]`.
 *                                        První endpoint by měl být běžná Apollo federace, druhý SDL-only GraphQL server.
 *                                        Výchozí: [`http://localhost:${PORT}/api/gql`, `http://localhost:${PORT}/sdl`]
 * @param {string} [finalendpoint=APIGQL] - Cesta, pod kterou stitching server poběží v rámci Expressu.
 *
 * @returns {Promise<void>} - Funkce je asynchronní a spustí stitching server jako middleware.
 *
 * @example
 * await startStitchedSdlServer(app);
 *
 * // Kombinované schéma je pak dostupné na:
 * // http://localhost:3000/${APIGQL}
 */
async function startStitchedSdlServer(app, sourceendpoints=[`http://localhost:${PORT}${APIRAWFEDERATION}`, `http://localhost:${PORT}/sdl`], finalendpoint=APIGQL) {
  const [GQLendpoint, SDLendpoint] = sourceendpoints
  const executorGQL = createRemoteExecutor(GQLendpoint);
  const executorSDL = createRemoteExecutor(SDLendpoint);

  const schema = stitchSchemas({
    subschemas: [
      {
        schema: await createRemoteWrappedSchema(executorGQL),
        batch: true,
      },
      {
        schema: await createRemoteWrappedSchema(executorSDL),
        mergeDirectives: true
      }
    ]
  });

  const stitchServer = new ApolloStitchServer({ schema });

  await stitchServer.start();

  app.use(
    finalendpoint,
    expressMiddleware(stitchServer, {
      context: async ({ req }) => ({
        headers: req.headers
      })
    })
  );

  console.log(`🧵 Stitched server running at ${APIGQL}`);
}

/**
 * Spustí GraphQL server na zadané cestě (`endpoint`), který poskytuje `_service.sdl`
 * se složeným federovaným SDL doplněným o direktivy z jednotlivých subgrafů.
 *
 * Používá `supergraphSdl` z Apollo Gateway jako základ a poté načte
 * jednotlivé `_service.sdl` ze subgrafů (z `config`) a spojí direktivy pomocí `mergeDirectives`.
 *
 * Výsledkem je GraphQL server, který odpovídá na dotaz:
 *
 * ```graphql
 * query {
 *   _service {
 *     sdl
 *   }
 * }
 * ```
 *
 * @param {ApolloGateway} gateway - Inicializovaná instance ApolloGateway, ze které se čte `supergraphSdl`.
 * @param {Array<{ name: string, url: string }>} config - Pole subgrafů s názvem a URL, na které se volá `_service.sdl`.
 * @param {import('express').Express} app - Express aplikace, ke které se server připojí jako middleware.
 * @param {string} [endpoint='/sdl'] - Cesta, na které bude GraphQL server dostupný.
 *
 * @returns {Promise<void>} - Asynchronně spustí GraphQL endpoint a stitching server.
 *
 * @example
 * await startSDLServer(gateway, config, app, '/sdl');
 *
 * // Výsledné GraphQL schéma je dostupné na:
 * // http://localhost:3000/sdl
 * // http://localhost:3000/api/sdl (stitched)
 */
async function startSDLServer(gateway, config, app, endpoint=APISDLOnly) {
  const sdlSchema = gql`
    type Query {
      _service: _Service!
    }

    type _Service {
      sdl: String
    }
  `;

  const sdlServer = new ApolloServerSDL({
    typeDefs: sdlSchema,
    resolvers: {
      Query: {
        _service: () => ({})
      },
      _Service: {
        sdl: async (_parent, _args, context) => {
          if (!gateway.supergraphSdl) {
            await gateway.load();
          }

          const gatewaySdl = gateway.supergraphSdl;
          const headers = context.headers || {};

          // Fetch SDLs from all subgraphs
          const subgraphSDLs = await Promise.all(
            config.map(async ({ url }) => {
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...headers
                },
                body: JSON.stringify({ query: '{ _service { sdl } }' })
              });
              const { data, errors } = await response.json();
              if (errors || !data?._service?.sdl) {
                throw new Error(`Failed to fetch SDL from ${url}`);
              }
              return data._service.sdl;
            })
          );

          // Merge directives into gateway SDL
          const merged = mergeDirectives(gatewaySdl, subgraphSDLs);

          return merged;
        }
      }
    }
  });

  await sdlServer.start();
  app.use(
    endpoint,
    expressMiddleware(sdlServer, {
      context: async ({ req }) => ({
        headers: req.headers
      })
    })
  );

  
}

/**
 * Spustí federovaný Apollo GraphQL server a připojí jej k Express aplikaci.
 *
 * 1. Inicializuje `ApolloGateway` s danými subgrafy (Apollo Federation 2).
 * 2. Přeposílá HTTP hlavičky (např. `Authorization`, `Cookie`) do jednotlivých subgrafů
 *    pomocí `willSendRequest` hooku v `RemoteGraphQLDataSource`.
 * 3. Spustí hlavní endpoint `/api/gql`, který slouží jako federovaný gateway.
 * 4. Paralelně spustí:
 *    - `/sdl` – GraphQL endpoint, který poskytuje složené SDL s direktivami
 *    - `/api/sdl` – stitching server kombinující `/api/gql` + `/sdl` do jednotného schématu
 *
 * @param {Array<{ name: string, url: string }>} config - Konfigurace subgrafů: název a URL každého zdroje.
 * @returns {Promise<void>} - Asynchronní spuštění všech serverů a připojení k Express.
 *
 * @example
 * const config = [
 *   { name: 'users', url: 'http://localhost:4001/graphql' },
 *   { name: 'posts', url: 'http://localhost:4002/graphql' }
 * ];
 * await startApolloServer(config);
 *
 * // Výsledné GraphQL endpointy:
 * // http://localhost:3000/api/gql   ← federovaný gateway
 * // http://localhost:3000/sdl       ← SDL-only GraphQL server s direktivami
 * // http://localhost:3000/api/sdl   ← stitched GraphQL server (kombinovaný)
 */
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

  const app = express();
  //const httpServer = http.createServer(app);

  const server = new ApolloServer({ gateway });


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
    path: APIRAWFEDERATION, 
    cors: false, 
    bodyParserConfig: false 
  });

  await startSDLServer(gateway, config, app);

  // spusťme Express server nejdřív
  app.listen(PORT, async () => {
    console.log(`🚀 Server ready at ${PORT}`);
    
    // stitching až po spuštění Express serveru
    try {
      await startStitchedSdlServer(app);
    } catch (err) {
      console.error("❌ Failed to start stitched server:", err);
    }
  });  

}

const config = readConfig();
startApolloServer(config);



