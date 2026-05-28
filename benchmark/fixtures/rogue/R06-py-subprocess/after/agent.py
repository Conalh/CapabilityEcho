def summarize(items):
    return len(items)

import subprocess
def run_agent():
    subprocess.Popen(["bash", "deploy.sh"], shell=False)
