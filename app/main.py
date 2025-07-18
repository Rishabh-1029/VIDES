import cv2
import numpy as np
from datetime import datetime
from app.config import settings
from app.detection.detector import model, tracker, obj_Detection
from app.detection.speed_calc import calculate_speed
from app.detection.roi import get_bev_homography, apply_bev_transform, is_in_polygon_roi
from app.events.overspeed import check_overspeed
from app.events.stalling import is_stalled
from app.events.opposite import opposite_vehicle_check
from app.events.accident import detect_accident
from app.events.heavy import heavy_vehicle_detection
from app.database.reports import reports

# ========== INIT ==========

H, bev_size = get_bev_homography(settings.src_pts)
cap = cv2.VideoCapture(settings.feed_ip_url)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, settings.dst_width)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, settings.dst_height)

if not cap.isOpened():
    print("Error: Could not open video stream.")
    exit()
else:
    print("Video stream opened successfully.")

fps = cap.get(cv2.CAP_PROP_FPS)
fps = fps if fps and not np.isnan(fps) else 20
print("FPS:", fps)

roi_polygon = settings.src_pts.reshape((-1, 1, 2))

# ========== TRACKING STATE ==========

car_coordinates = {}
latest_boxes_coords = {}
stall_cars = []
opposite_cars = []
overspeed = {}
Heavy_vehicles = []
vehicle_count = {}
counted_vehicle = set()

# ========== UTILITY ==========

def vehicle_count_fn(track_id, class_name):
    if track_id not in counted_vehicle:
        counted_vehicle.add(track_id)
        vehicle_count[class_name] = vehicle_count.get(class_name, 0) + 1

def heavy_vehicle(track_id,x1, y1, x2, y2):
    if track_id not in Heavy_vehicles:
        if(heavy_vehicle_detection(x1, y1, x2, y2,H)):
            if len(Heavy_vehicles) > 30:
                Heavy_vehicles.pop(0)
            Heavy_vehicles.append(track_id)

def update_car_coords(track_id, x1, y1, x2, y2):
    cx, cy = int((x1 + x2) / 2), int((y1 + y2) / 2)
    bev_x, bev_y = apply_bev_transform((cx, cy), H)
    if track_id not in car_coordinates:
        car_coordinates[track_id] = []
    if len(car_coordinates[track_id]) >= 20:
        car_coordinates[track_id].pop(0)
    car_coordinates[track_id].append([bev_x, bev_y])

def detect_movement(track_id):
    coords = car_coordinates[track_id]
    if len(coords) < 5:
        return

    x1, y1 = coords[-5]
    x2, y2 = coords[-1]

    # Opposite Movement
    if opposite_vehicle_check(x1, x2, y1, y2, settings.expected_movement, threshold=0.75):
        if track_id not in opposite_cars:
            if len(opposite_cars) > 30:
                opposite_cars.pop(0)
            opposite_cars.append(track_id)

    # Stalling
    if is_stalled(car_coordinates, track_id, fps, settings.meters_per_pixel):
        if track_id not in stall_cars:
            if len(stall_cars) > 50:
                stall_cars.pop(0)
            stall_cars.append(track_id)

def draw_Tracks(tracks, frame):
    global latest_boxes_coords

    cv2.polylines(frame, [roi_polygon.astype(np.int32)], isClosed=True, color=(255, 0, 0), thickness=1)

    for track in tracks:
        if not track.is_confirmed():
            continue

        track_id = track.track_id
        x1, y1, x2, y2 = map(int, track.to_ltrb())
        latest_boxes_coords[track_id] = [x1, y1, x2, y2]
        class_name = track.get_det_class()

        vehicle_count_fn(track_id, class_name)

        if class_name == "truck":
            heavy_vehicle(track_id,x1, y1, x2, y2)

        # Skip if outside ROI
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        if not is_in_polygon_roi(cx, cy, roi_polygon):
            continue

        update_car_coords(track_id, x1, y1, x2, y2)
        detect_movement(track_id)

        speed = calculate_speed(car_coordinates[track_id], fps, settings.meters_per_pixel)
        check_overspeed(track_id, speed, settings.speed_limit, overspeed)

        # Drawing box
        label = f"ID {track_id} | {class_name} | {speed:.1f} km/h"
        color = (
            (0, 255, 255) if track_id in stall_cars else
            (0, 0, 255) if track_id in opposite_cars else
            (0, 165, 255) if speed > settings.speed_limit else
            (0, 255, 0)
        )
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 1)
        cv2.putText(frame, label, (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)

# ========== MAIN LOOP ==========

print("\n--- Feed Started ---\n")

while True:
    ret, frame = cap.read()
    if not ret:
        cap.grab()
        break

    frame = cv2.resize(frame, (settings.dst_width, settings.dst_height))
    results = model(frame, device=settings.device, conf=0.6, verbose = False)[0]

    detections = []
    obj_Detection(results, detections)
    tracks = tracker.update_tracks(detections, frame=frame)

    draw_Tracks(tracks, frame)

    _ = detect_accident(stall_cars, latest_boxes_coords)

    cv2.imshow("Live Detection", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()

total_vehicle = len(car_coordinates)
print(f"Total Vehicles = {total_vehicle}\n")
print("\n---Feed Ended---\n")
print("\n---Total Vehicle Count---\n")
for vehicle in vehicle_count:
    print(f"{vehicle} : {vehicle_count[vehicle]}")
reports(stall_cars, opposite_cars, overspeed, Heavy_vehicles)
