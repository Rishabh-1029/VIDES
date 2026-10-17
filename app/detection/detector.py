import importlib.util

from app.config.settings import allowed_obj_vehicle


def create_tracker():
    """Create DeepSORT, falling back when its optional embedder is unavailable."""
    from deep_sort_realtime.deepsort_tracker import DeepSort

    if importlib.util.find_spec("pkg_resources") is None:
        return DeepSort(max_age=25, embedder=None), True
    try:
        return DeepSort(max_age=25), False
    except ModuleNotFoundError as exc:
        if exc.name != "pkg_resources":
            raise
        return DeepSort(max_age=25, embedder=None), True


def appearance_embeddings(frame, detections):
    """Build lightweight HSV appearance vectors for DeepSORT's fallback mode."""
    import cv2
    import numpy as np

    embeddings = []
    frame_height, frame_width = frame.shape[:2]
    for detection in detections:
        x, y, width, height = map(int, detection[0])
        x1, y1 = max(0, x), max(0, y)
        x2, y2 = min(frame_width, x + width), min(frame_height, y + height)
        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            embeddings.append(np.zeros(128, dtype=np.float32))
            continue
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        histogram = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256])
        cv2.normalize(histogram, histogram, norm_type=cv2.NORM_L2)
        embeddings.append(histogram.reshape(-1).astype(np.float32))
    return embeddings

def obj_Detection(results, detections):
    for box in results.boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        class_id = int(box.cls[0])
        if class_id not in allowed_obj_vehicle:
            continue
        class_name = results.names[class_id]
        confidence = float(box.conf[0])
        detections.append(([x1, y1, x2 - x1, y2 - y1], confidence, class_name))
