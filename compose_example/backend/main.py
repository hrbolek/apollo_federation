import uuid
import strawberry
import fastapi
import aiohttp
import os

from fastapi.responses import JSONResponse, FileResponse

from strawberry.fastapi import GraphQLRouter

from pydantic import BaseModel

class Item(BaseModel):
    query: str
    variables: dict = None
    operationName: str = None


app = fastapi.FastAPI()

@app.get("/api/gql", response_class=FileResponse)
async def graphiql():
    realpath = os.path.realpath("./graphiql.html")
    return realpath

@app.post("/api/gql", response_class=JSONResponse)
async def gql(data: Item, request: fastapi.Request):
    proxy = "http://apollo:3000/api/gql"
    gqlQuery = {}
    if (data.operationName) is not None:
        gqlQuery["operationName"] = data.operationName

    gqlQuery["query"] = data.query
    if (data.variables) is not None:
        gqlQuery["variables"] = data.variables

    headers = request.headers
    c = dict(headers.items())
    headers = {"cookie": c.get("cookie", None)}
    authorizationHeader = c.get("authorization", None)
    if authorizationHeader is not None:
        headers["authorization"] = authorizationHeader
    AuthorizationHeader = c.get("Authorization", None)
    if authorizationHeader is not None:
        headers["Authorization"] = AuthorizationHeader
    print("outgoing:", headers)
    async with aiohttp.ClientSession() as session:
        async with session.post(proxy, json=gqlQuery, headers=headers) as resp:
            # print(resp.status)
            json = await resp.json()
    return JSONResponse(content=json, status_code=resp.status)    
    pass