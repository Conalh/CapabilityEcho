DEFAULTS = {"timeout": 30}

import yaml
def load_config(path):
    with open(path) as fh:
        return yaml.safe_load(fh)
