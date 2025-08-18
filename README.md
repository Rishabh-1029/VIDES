# VIDES - Vehicle Intelligent Detection & Event System

**VIDES** (Vehicle Intelligent Detection & Event System) is a modular, real-time traffic monitoring application that leverages YOLOv8, DeepSORT, and OpenCV to detect and track vehicles from video feeds(Live and Recorded). It identifies traffic violations and abnormal events such as overspeeding, wrong direction movement, stalling, accidents, and heavy vehicle entry.

---

## Features

- Real-time vehicle detection and multi-object tracking
- Bird’s Eye View (BEV) transformation for accurate region analysis
- Speed calculation based on frame-to-frame motion
- Modular event detection:
  - Overspeeding
  - Opposite direction movement
  - Stalling
  - Accidents
  - Heavy vehicle presence
- Structured codebase with separation of concerns

---

## Custom Model (Faster R-CNN)

For research and experimentation purposes, VIDES also includes a custom vehicle detection model based on Faster R-CNN architecture. This model is trained and evaluated separately from the main YOLOv8 pipeline to explore performance trade-offs and detection accuracy in different traffic scenarios.

Link : [https://github.com/Rishabh-1029/ATMS-project/Custom_Vehicle_detection](https://github.com/Rishabh-1029/ATMS-project/tree/main/Custom%20model%20for%20Object%20Detection)

---

## Automatic Number Plate Recognition (ANPR)

The ANPR system includes a vehicle detection and a custom number plate detection model based on the YOLOv8 architecture. This model is trained and evaluated independently to ensure high detection accuracy and robustness across various vehicle types and plate formats.

The model demonstrates strong performance metrics including high precision and recall, making it a reliable component in real-world traffic surveillance and recognition tasks. It serves as a specialized enhancement over generic object detectors for number plate localization.

Link : [https://github.com/Rishabh-1029/ANPR](https://github.com/Rishabh-1029/ANPR)

---

## Tech Stack
  
  language: 
    - Python 3.10+
  
  object_detection:
    library: YOLOv8
    source: https://github.com/ultralytics/ultralytics

  object_tracking:
    library: DeepSORT
    implementation: deep_sort_realtime
    source: https://github.com/nwojke/deep_sort

  computer_vision:
    - OpenCV

  data_processing:
    - NumPy
    - Pandas
