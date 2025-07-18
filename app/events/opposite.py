import math

def opposite_vehicle_check(x1, x2, y1, y2, expected, threshold):
    def normalize(v):
        mag = math.sqrt(v[0] ** 2 + v[1] ** 2)
        return [v[0] / mag, v[1] / mag] if mag else [0, 0]

    def cosine_similarity(vec1, vec2):
        dot = vec1[0]*vec2[0] + vec1[1]*vec2[1]
        mag1 = math.sqrt(vec1[0]**2 + vec1[1]**2)
        mag2 = math.sqrt(vec2[0]**2 + vec2[1]**2)
        return dot / (mag1 * mag2) if mag1 and mag2 else 1

    movement = [x2 - x1, y2 - y1]
    unit_movement = normalize(movement)
    similarity = cosine_similarity(unit_movement, expected)
    return similarity < -threshold
