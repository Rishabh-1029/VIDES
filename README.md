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

---

## Project Structure

VIDES-Project/
│
├── app/
│ ├── main.py # Application entry point
│ │
│ ├── config/
│ │ └── settings.py # Configuration: source points, device, model paths
│ │
│ ├── detection/
│ │ ├── detector.py # YOLOv8 + DeepSORT implementation
│ │ ├── roi.py # BEV transformation, ROI check
│ │ └── speed_calc.py # Speed calculation logic
│ │
│ ├── events/
│ │ ├── overspeed.py
│ │ ├── stalling.py
│ │ ├── opposite.py
│ │ ├── accident.py
│ │ └── heavy.py # Event logic implementations
│ │
│ ├── database/
│ │ ├── models.py # Database schema
│ │ └── crud.py # Database interaction logic
│
├── .env # Environment variables
├── .gitignore
├── requirements.txt # Python package requirements
└── README.md