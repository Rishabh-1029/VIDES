def check_overspeed(track_id, speed, speed_limit, overspeed_dict, max_len=30):
    if speed > speed_limit and track_id not in overspeed_dict:
        if len(overspeed_dict) > max_len:
            overspeed_dict.pop(next(iter(overspeed_dict)))
        overspeed_dict[track_id] = speed
