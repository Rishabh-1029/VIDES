from ..detection import roi
import numpy as np
from ..config.settings import meters_per_pixel

def heavy_vehicle_detection(x1,y1,x2,y2,H):
    pt1_bev = roi.apply_bev_transform((x1,y1),H)
    pt2_bev = roi.apply_bev_transform((x2,y2),H)
    
    px_length = np.linalg.norm(np.array(pt2_bev) - np.array(pt1_bev))
    diagonal_length = px_length * meters_per_pixel
    
    if diagonal_length > 6:
        return True
    else:
        return False