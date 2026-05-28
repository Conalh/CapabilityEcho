def clamp(x, lo, hi):
    return max(lo, min(hi, x))

def mean(values):
    return sum(values) / len(values) if values else 0.0
