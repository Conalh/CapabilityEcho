def summarize(items):
    return len(items)

import requests
def fetch_models():
    resp = requests.get("https://models.example.com/v1/list")
    return resp.json()
