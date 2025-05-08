import uuid
import strawberry
import fastapi
import typing

from strawberry.fastapi import GraphQLRouter


@strawberry.federation.type(keys=["id"])
class ComplexGQLModel:
    id: uuid.UUID = strawberry.field()
    x: str = strawberry.field()
    y: str = strawberry.field()

@strawberry.federation.type(keys=["id"])
class UserGQLModel:
    id: uuid.UUID = strawberry.field()
    name: str = strawberry.field()

    @classmethod
    async def resolve_reference(cls, info: strawberry.types.Info, id: uuid.UUID):
        if id is None:
            return None
        _id = uuid.UUID(id) if isinstance(id, str) else id
        name = f"name {id}"
        instance = cls(id=_id, name=name)
        return instance
    
    @strawberry.field(description="""Finds an user by their id""")
    async def vector(self, info: strawberry.types.Info) -> typing.List[int]:
        return [i for i in range(10)]

    @strawberry.field(description="""Finds an user by their id""")
    async def complex(self, info: strawberry.types.Info) -> typing.Optional[ComplexGQLModel]:
        return ComplexGQLModel(x="x", y="y", id=f"{uuid.uuid4()}")


@strawberry.type(description="""Type for query root""")
class Query:
    @strawberry.field(description="""Finds an user by their id""")
    async def user_by_id(self, info: strawberry.types.Info, id: uuid.UUID) -> UserGQLModel:
        return await UserGQLModel.resolve_reference(info=info, id=id)

schema = strawberry.federation.Schema(query=Query, enable_federation_2=True)

app = fastapi.FastAPI()

graphql_app = GraphQLRouter(schema)

app.include_router(graphql_app, prefix="/gql")
