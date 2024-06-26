//const { ApolloServer } = require("apollo-server");
const { json, OptionsJson } = require('body-parser');
const { ApolloServer } = require("apollo-server-express");

const { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } = require("@apollo/gateway");

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
    path: '/api/gql', 
    cors: false, 
    bodyParserConfig: false 
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
