import torch
import numpy as np
from dotenv import load_dotenv
import os

load_dotenv()

feed_ip_url=os.getenv("feed_ip_url")
print(feed_ip_url)

device = 0 if torch.cuda.is_available() else 'cpu'
model_path = os.getenv("model_path")

src_pts = np.array([[245, 0], [330, 0], [740, 360], [0, 360]], np.float32)
dst_width = 640
dst_height = 360
speed_limit = 30
expected_movement = [0, -1]
meters_per_pixel = 50 / 360

allowed_obj_vehicle = [1, 2, 3, 5, 7]
