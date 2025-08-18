import cv2
import numpy as np
from app.config.settings import src_pts, dst_width, dst_height

# BEV

# Mapping BEV
def get_bev_homography(src_pts=src_pts, dst_width=dst_width, dst_height=dst_height):
    dst_pts = np.float32([[0, 0], [dst_width, 0], [dst_width, dst_height], [0, dst_height]])
    H, _ = cv2.findHomography(src_pts, dst_pts)
    return H, (dst_width, dst_height)

# Applying BEV
def apply_bev_transform(point, H):
    point = np.array([[point]], dtype='float32')
    transformed = cv2.perspectiveTransform(point, H)
    return transformed[0][0]

# Vehicle occurence in ROI
def is_in_polygon_roi(x, y, polygon):
    return cv2.pointPolygonTest(polygon, (x, y), False) >= 0