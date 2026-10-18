# VIDES — Vehicle Intelligent Detection & Event System

<p align="center">
  <img src="frontend/vides-favicon.svg" alt="VIDES logo" width="120" />
</p>

VIDES (Vehicle Intelligent Detection & Event System) is a vehicle detection and event-monitoring component of ATMS (Advanced Traffic Management System). It is a modular, real-time traffic monitoring application that uses YOLOv8, DeepSORT, and OpenCV to detect and track vehicles in live camera feeds and recorded video. It estimates vehicle speed and records traffic violations and unusual events such as overspeeding, wrong-way movement, stalling, possible collisions for accident review, and heavy-vehicle entry.

The Python backend processes the video source. A browser dashboard lets an operator configure the view, monitor detection, review session events, and download reports.

Deployed URL : `https://vides.onrender.com/`

## Features

- Real-time vehicle detection and multi-object tracking.
- Bird’s-eye-view (BEV) perspective transformation to map the selected road area to a flattened plane for analysis.
- Speed estimates based on vehicle movement across video frames and a user-provided road-distance calibration.
- Modular event checks for:
  - Overspeeding.
  - Movement against the configured traffic direction.
  - Stalled vehicles.
  - Possible collisions.
  - Heavy vehicles.
- A structured codebase with separate modules for video capture, detection, tracking, event checks, and reports.
- A browser dashboard for cameras, network streams, and uploaded video, with live annotated video and session statistics.
- A perspective-shaped detection-zone editor, 360° flow-direction control, speed calibration, and detector-confidence setting.
- A scrollable session event log and downloadable CSV and JSON reports.

## Models and related projects

### Active VIDES detector

The dashboard’s live detection pipeline uses YOLOv8. The default model is `models/Custom_yolov8m.pt`; `models/yolov8n.pt` is also available. Configure lets you select a model and waits for it to finish loading before detection can start. VIDES loads one detector model at a time.

### Faster R-CNN vehicle-detection research

VIDES also has a custom vehicle detector based on Faster R-CNN for research and experimentation. It is trained and evaluated separately from the main YOLOv8 pipeline so the models can be compared across traffic scenes.

[View the custom vehicle-detection project](https://github.com/Rishabh-1029/ATMS-project/tree/main/Custom%20model%20for%20Object%20Detection)

### Automatic Number Plate Recognition (ANPR)

The related ANPR project contains vehicle detection and a custom YOLOv8 number-plate detector. It is trained and evaluated independently for precision and recall across vehicle types and plate formats. The project describes strong precision and recall and presents plate localization as a specialized enhancement over general vehicle detection; see its repository for the model and evaluation details.

[View the ANPR project](https://github.com/Rishabh-1029/ANPR)

These Faster R-CNN and ANPR projects are separate research/companion projects; the current VIDES dashboard’s live session uses the selected YOLOv8 model.

## Technology stack

- **Language:** Python.
- **Computer vision and video processing:** OpenCV.
- **Active object detection:** YOLOv8 through [Ultralytics](https://github.com/ultralytics/ultralytics).
- **Vehicle tracking:** [DeepSORT](https://github.com/nwojke/deep_sort) through `deep_sort_realtime`.
- **Research detection model:** [Faster R-CNN](https://github.com/jwyang/faster-rcnn.pytorch), maintained separately from the live YOLOv8 pipeline.
- **Data processing:** NumPy and Pandas.
- **Dashboard API:** FastAPI and Uvicorn.

DeepSORT uses its MobileNet appearance embedder when available. If the installed Python packaging tools do not provide `pkg_resources`, VIDES uses HSV appearance features as a fallback so tracking can still run.

## Run VIDES

From the VIDES project directory, create a Python environment and install the dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start the API and dashboard:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Open <http://127.0.0.1:8000>. The VIDES handbook opens by default; use **Configure** to prepare a feed and **Monitor** to view a running session. The API serves the dashboard, video stream, session controls, and event data from the same origin. FastAPI’s interactive API documentation is at <http://127.0.0.1:8000/docs>.

## Configure and start a session

1. Choose a local camera, a network stream URL, a configured feed, or an uploaded video. Camera capture uses a camera connected to the machine running the VIDES backend, not the computer or phone viewing the dashboard. Uploaded videos can be up to 500 MB.
2. Capture a preview frame. For an uploaded video, use the frame slider to choose a useful point in the clip.
3. Set the four corners of the road detection area. The padded editor allows corners to extend up to 25% beyond the frame edges, which helps when the road continues out of view. Keep the points in order and make a convex, non-crossing shape.
4. Choose a detection model and wait for its status to show that it is loaded.
5. Set the expected traffic direction using the rotatable arrow. The angle starts at 0° pointing up and increases clockwise.
6. Enter a known road length along that direction, choose the speed limit, and set detection confidence. Apply the traffic settings.
7. Start detection. VIDES opens Monitor when the session begins. Switching dashboard pages does not stop an active session.

The default model path is `models/Custom_yolov8m.pt`. To change the startup model or make a configured network feed available, add values to a `.env` file in the project directory:

```dotenv
model_path=models/Custom_yolov8m.pt
feed_ip_url=rtsp://camera-address/stream
```

Detection-zone coordinates are stored in `config/roi.json`; traffic settings are stored in `config/traffic.json`. Use the Documentation page in the dashboard for the operator guide and event definitions. The **Restart app** control restarts the Uvicorn reload worker and clears in-memory session results; it requires VIDES to be started with the `--reload` command above. Saved zone and traffic settings remain on disk.

## Speed estimates and event interpretation

The four zone corners define a perspective transform that maps the selected road area to a flattened plane. VIDES tracks vehicle positions on that plane and estimates speed using the road length entered in the traffic profile. Accurate results depend on placing the corners on the road surface, choosing the matching flow direction, and entering a measured road distance.

Lower detection confidence can find more vehicles but may also allow more false detections. Higher confidence is more selective and can miss weaker detections. Tune it for the camera view and model.

A possible-collision event is a review alert raised when the bounding boxes of two vehicles already marked as stalled overlap. It is not a standalone crash classifier and does not confirm that a collision occurred. See the dashboard Documentation page for the conditions used by each event check.

## Session records and reports

VIDES keeps all event records for the active session in memory without a fixed record limit. The Events & reports page lists them newest first, and downloaded CSV and JSON reports include every event record along with session details, source, calibration, vehicle counts, and average speed. Starting a new session resets its metrics and event history; restarting VIDES clears in-memory session data. Configuration files remain saved on disk.

## API routes

- `GET /api/health`, `GET /api/config`, `GET /api/status`, and `GET /api/events`.
- `POST /api/session/preview` to capture a source frame (`frame_index` seeks within an upload).
- `POST /api/session/upload` to stage a video file.
- `POST /api/session/start` and `POST /api/session/stop`.
- `PUT /api/config/roi` to validate, save, and apply the detection region.
- `PUT /api/config/traffic` to save flow direction, road calibration, speed limit, and detector confidence.
- `PUT /api/config/model` to select and load an included model file.
- `GET /api/reports/download?format=csv|json` to download the active session report.
- `POST /api/system/restart` to ask the Uvicorn `--reload` supervisor to restart the service worker.
- `GET /api/stream` for the annotated MJPEG video feed.
