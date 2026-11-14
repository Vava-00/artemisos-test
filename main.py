from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def inicio():
    return {
        "mensaje": "¡Artemisos está funcionando!",
        "estado": "online"
    }
