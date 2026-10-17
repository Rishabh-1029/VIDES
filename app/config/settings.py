import numpy as np
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# RTSP feed
feed_ip_url = os.getenv("feed_ip_url") or None

# YOLO model for vehicle detection. The custom VIDES model is the default.
model_path = Path(os.getenv("model_path", str(Path(__file__).resolve().parents[2] / "models" / "Custom_yolov8m.pt")))

# Region of Interest (ROI)
src_pts = np.array([[245, 0], [330, 0], [640, 360], [0, 360]], np.float32)

# Frame Size
dst_width = 640
dst_height = 360

# Speed Limit
speed_limit = 30
detection_confidence = 0.6

# Vehicle expected movement
expected_movement = [0, -1]

# Meter to pixel
meters_per_pixel = 50 / 360

# Allowed Vehicle
allowed_obj_vehicle = [1, 2, 3, 5, 7]
