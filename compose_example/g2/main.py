import uuid
import strawberry
import fastapi
import typing

from strawberry.fastapi import GraphQLRouter
@strawberry.federation.type(keys=["id"])
class ComplexGQLModel:
    id: uuid.UUID = strawberry.federation.field()
    x: str = strawberry.federation.field(external=True)
    y: str = strawberry.federation.field(external=True)

    @strawberry.federation.field(requires=["x", "y"])
    def value(self) -> typing.Optional[str]:
        return f"(x: {self.x}; y: {self.y})"


@strawberry.federation.type(extend=True, keys=["id"])
class UserGQLModel:
    id: uuid.UUID = strawberry.federation.field()
    name: str = strawberry.federation.field(external=True)
    vector: typing.List[int] = strawberry.federation.field(external=True)
    complex: typing.Optional[ComplexGQLModel] = strawberry.federation.field(external=True)

    @classmethod
    async def resolve_reference(cls, info: strawberry.types.Info, **data: typing.Any):
        id = data.get("id", None)
        name = data.get("name", None)
        vector = data.get("vector", [])
        complex = data.get("complex", None)
        print(f"complex = {complex}")
        if id is None:
            return None
        _id = uuid.UUID(id) if isinstance(id, str) else id
        instance = cls(id=_id, name=name, vector=vector, complex=complex)
        return instance
    
    @strawberry.federation.field(requires=["name", "vector", "complex{x y id value}"])
    def name_plus(self) -> typing.Optional[str]:
        if self.name is not None:
            return f"{self.name} {self.vector}+ {self.complex}"

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
