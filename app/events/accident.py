def detect_accident(stall_cars, latest_boxes_coords):
    collision_record = {}
    def cal_iou(boxA, boxB):
        xA = max(boxA[0], boxB[0])
        yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2])
        yB = min(boxA[3], boxB[3])
        interArea = max(0, xB - xA) * max(0, yB - yA)
        if interArea == 0: return 0.0
        boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1])
        boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1])
        return interArea / float(boxAArea + boxBArea - interArea)

    for id1 in stall_cars:
        for id2 in stall_cars:
            if id1 == id2: continue
            if id1 not in latest_boxes_coords or id2 not in latest_boxes_coords: continue
            iou = cal_iou(latest_boxes_coords[id1], latest_boxes_coords[id2])
            if iou > 0.5:
                if id1 not in collision_record:
                    collision_record[id1] = []
                if id2 not in collision_record[id1]:
                    collision_record[id1].append(id2)
    return collision_record
