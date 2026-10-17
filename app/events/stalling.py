import math

def is_stalled(car_coordinates, car_id, fps, meters_per_pixel):
    def eucledian(pt1, pt2):
        return math.sqrt((pt1[0] - pt2[0])**2 + (pt1[1] - pt2[1])**2)

    if car_id not in car_coordinates:
        return False

    coords = car_coordinates[car_id]
    window = max(1, int(fps * 5))
    if len(coords) < window:
        return False

    recent_coords = coords[-window:]
    base_coord = recent_coords[0]

    for pt in recent_coords[1:]:
        if eucledian(base_coord, pt) >= 1 / meters_per_pixel:
            return False
    return True
