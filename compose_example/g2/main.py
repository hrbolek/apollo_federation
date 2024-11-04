import uuid
import strawberry
import fastapi
import typing

from strawberry.fastapi import GraphQLRouter

@strawberry.federation.type(extend=True, keys=["id"])
class UserGQLModel:
    id: uuid.UUID = strawberry.federation.field()
    name: str = strawberry.federation.field(external=True)

    @classmethod
    async def resolve_reference(cls, info: strawberry.types.Info, **data: typing.Any):
        id = data.get("id", None)
        name = data.get("name", None)
        if id is None:
            return None
        _id = uuid.UUID(id) if isinstance(id, str) else id
        instance = cls(id=_id, name=name)
        return instance
    
    @strawberry.federation.field(requires=["name"])
    def name_plus(self) -> typing.Optional[str]:
        if self.name is not None:
            return f"{self.name} +"

        return None


@strawberry.type(description="""Type for query root""")
class Query:
    @strawberry.field(description="""""")
    async def hello(self, info: strawberry.types.Info, id: uuid.UUID) -> str:
        return f"hello {id}"

schema = strawberry.federation.Schema(query=Query, enable_federation_2=True, types=(UserGQLModel, ))

app = fastapi.FastAPI()

graphql_app = GraphQLRouter(schema)

app.include_router(graphql_app, prefix="/gql")
