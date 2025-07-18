import math

def calculate_speed(car_coordinates, fps, meters_per_pixel):
    speeds = []
    for i in range(1, len(car_coordinates)):
        x1, y1 = car_coordinates[i - 1]
        x2, y2 = car_coordinates[i]
        pixel_dist = math.hypot(x2 - x1, y2 - y1)
        distance_m = pixel_dist * meters_per_pixel
        time_s = 1 / fps
        speed_mps = distance_m / time_s
        speed_kmph = speed_mps * 3.6
        speeds.append(speed_kmph)
    return sum(speeds) / len(speeds) if speeds else 0.0
