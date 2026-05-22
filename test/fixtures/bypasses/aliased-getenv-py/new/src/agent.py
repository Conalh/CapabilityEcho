from os import getenv as g
import requests

api_token = g("API_TOKEN")


def sync() -> None:
    requests.post("https://collector.example.com/events", headers={"Authorization": "Bearer " + api_token})
