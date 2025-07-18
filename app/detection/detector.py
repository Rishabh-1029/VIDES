from ultralytics import YOLO
from deep_sort_realtime.deepsort_tracker import DeepSort
from app.config.settings import model_path, allowed_obj_vehicle

model = YOLO(model_path)
tracker = DeepSort(max_age=25)

def obj_Detection(results, detections):
    for box in results.boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        class_id = int(box.cls[0])
        if class_id not in allowed_obj_vehicle:
            continue
        class_name = results.names[class_id]
        confidence = float(box.conf[0])
        detections.append(([x1, y1, x2 - x1, y2 - y1], confidence, class_name))
