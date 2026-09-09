# SANJEEVANI

## IOT And AI-Powered Real-Time Environmental Disaster Detection and Response System

SANJEEVANI is an AI-powered environmental hazard monitoring and emergency response platform designed to detect disasters such as floods and gas leaks in real time.

The system combines IoT sensor data, machine learning, anomaly detection, real-time monitoring, risk classification, geospatial visualization, emergency alerts, and citizen safety services into a unified platform.

The primary objective of SANJEEVANI is to reduce disaster response time and provide early warnings so that authorities and citizens can take timely action.

---

## Problem Statement

Natural and industrial disasters can escalate rapidly, while conventional monitoring systems often depend on manual observation or isolated sensor systems.

This creates several challenges:

* Delayed disaster detection
* Difficulty identifying the exact affected area
* Lack of centralized real-time monitoring
* False or delayed alerts
* Difficulty assessing disaster severity
* Limited information for citizens during emergencies
* Slow coordination between authorities and emergency services

SANJEEVANI addresses these challenges by integrating real-time sensor monitoring with AI-based risk analysis and emergency response mechanisms.

---

## Proposed Solution

SANJEEVANI continuously collects environmental data from sensors and processes it through an integrated backend and AI pipeline.

The system:

1. Collects real-time sensor readings
2. Processes and validates incoming data
3. Detects abnormal environmental conditions
4. Uses trained machine learning models to estimate disaster risk
5. Classifies areas according to risk level
6. Displays affected regions on a live dashboard
7. Generates alerts for critical situations
8. Provides emergency response information
9. Helps citizens identify safer areas and nearby emergency facilities

---

## Key Features

### Real-Time Sensor Monitoring

The system receives environmental readings from IoT sensors and continuously updates the monitoring dashboard.

Sensor data can include parameters such as:

* Water level
* Rainfall
* Temperature
* Humidity
* Gas concentration
* Environmental anomalies

---

### AI-Based Flood Risk Prediction

SANJEEVANI uses a machine learning model to analyze environmental parameters and determine flood risk.

The system classifies the situation into different risk levels:

* Low Risk
* Moderate Risk
* High Risk
* Critical Risk

The model can be trained using historical environmental and disaster-related datasets.

---

### Gas Leak Detection

The system monitors gas-related sensor readings and detects abnormal patterns.

When dangerous readings are identified, the system can:

* Detect the anomaly
* Estimate severity
* Identify the affected area
* Generate an alert
* Notify the monitoring system

---

### Anomaly Detection

SANJEEVANI includes an anomaly detection pipeline to identify unusual sensor behavior.

This helps detect potentially dangerous situations even when sensor readings do not exactly match previously observed disaster patterns.

---

### Real-Time Disaster Dashboard

The web dashboard provides a centralized view of the disaster monitoring system.

It can display:

* Live sensor readings
* Current risk level
* Disaster location
* Flood status
* Gas leak status
* Active alerts
* Critical zones
* Safe zones
* Nearby emergency facilities
* Response information

---

### Risk Zone Mapping

The platform categorizes geographical areas according to their current risk level.

Example:

```text
Green   -> Safe
Yellow  -> Moderate Risk
Orange  -> High Risk
Red     -> Critical
```

This allows authorities and citizens to quickly understand the severity of a situation.

---

### Citizen Safety Portal

SANJEEVANI provides a citizen-facing interface where users can access important emergency information.

The portal can provide:

* Current location-based risk information
* Safe zones
* Critical zones
* Disaster alerts
* Nearby hospitals
* Emergency information
* SOS functionality

---

### SOS Emergency System

The SOS module provides a mechanism for users to request emergency assistance during critical situations.

The system can be integrated with location information and emergency response services.

---

### Emergency Facility Mapping

SANJEEVANI maintains information about nearby emergency facilities such as hospitals.

This information can be used during emergency response and evacuation planning.

---

## System Architecture

```text
                    IoT Sensors
                         |
                         v
              +---------------------+
              | Sensor Data Layer   |
              +---------------------+
                         |
                         v
              +---------------------+
              | Backend Server      |
              | Node.js / Express   |
              +---------------------+
                         |
             +-----------+-----------+
             |                       |
             v                       v
     AI / ML Pipeline          Anomaly Detection
             |                       |
             +-----------+-----------+
                         |
                         v
              +---------------------+
              | Risk Classification |
              +---------------------+
                         |
                         v
              +---------------------+
              | Real-Time Dashboard |
              +---------------------+
                         |
             +-----------+-----------+
             |                       |
             v                       v
       Authority Portal       Citizen Portal
                                     |
                                     v
                              SOS / Safe Zones
```

---

## Technology Stack

### Frontend

* HTML
* CSS
* JavaScript
* Interactive maps
* Real-time dashboard components

### Backend

* Node.js
* Express.js
* REST APIs
* CORS

### Artificial Intelligence and Machine Learning

* Python
* Scikit-learn
* Pandas
* NumPy
* Machine Learning models
* Anomaly detection
* Risk classification

### IoT

* Arduino
* Environmental sensors
* Simulated sensor data

### Data Processing

* CSV datasets
* Historical sensor data
* JSON-based emergency facility data

---

## Project Structure

```text
SIH-2026/
|
├── data/
|   └── Historical and sensor datasets
|
├── sample_sops/
|   └── Sample standard operating procedures
|
├── anomaly_detection.py
|   └── Anomaly detection pipeline
|
├── arduino code.txt
|   └── Arduino sensor code
|
├── backend_server.py
|   └── Python backend/AI integration
|
├── export_readings_to_csv.py
|   └── Sensor data export utility
|
├── flood_risk_model.py
|   └── Flood risk prediction model
|
├── hospitals.json
|   └── Emergency hospital information
|
├── index.html
|   └── Main monitoring dashboard
|
├── integration_pipeline.py
|   └── AI and system integration pipeline
|
├── officer.html
|   └── Disaster authority dashboard
|
├── rag_alert_pipeline.py
|   └── Alert generation and RAG pipeline
|
├── server.js
|   └── Node.js backend server
|
├── simulation.js
|   └── Real-time sensor data simulation
|
├── sos.html
|   └── Citizen SOS interface
|
├── train_models.py
|   └── Machine learning model training
|
├── package.json
|   └── Node.js dependencies
|
└── requirements.txt
    └── Python dependencies
```

The repository currently contains the Node.js backend, simulation system, Python AI/ML modules, dashboard pages, emergency data, and IoT-related code.

---

## Data Flow

```text
Sensors
   |
   v
Sensor Readings
   |
   v
Backend Server
   |
   +------------------+
   |                  |
   v                  v
Flood Model      Anomaly Model
   |                  |
   +--------+---------+
            |
            v
      Risk Assessment
            |
            v
      Disaster Location
            |
            v
       Alert System
            |
      +-----+-----+
      |           |
      v           v
 Authority     Citizens
 Dashboard     Portal
```

---

## AI Pipeline

SANJEEVANI follows a structured machine learning pipeline.

```text
Historical Data
      |
      v
Data Preprocessing
      |
      v
Feature Selection
      |
      v
Data Scaling
      |
      v
Model Training
      |
      v
Model Evaluation
      |
      v
Real-Time Prediction
      |
      v
Risk Classification
```

Model performance can be evaluated using:

* Accuracy
* Precision
* Recall
* F1 Score
* Confusion Matrix

Standardization can be performed using `StandardScaler` to normalize numerical features before model training.

---

## Real-Time Simulation

The project includes a sensor simulation module that generates environmental readings for testing the complete system without requiring physical IoT hardware.

The simulation can be used to reproduce scenarios such as:

```text
Normal Conditions
       |
       v
Increasing Sensor Values
       |
       v
Abnormal Readings
       |
       v
High Risk
       |
       v
Critical Disaster
```

This allows the complete disaster detection pipeline to be demonstrated during development and testing.

---

## Running the Project

### Prerequisites

Install the following:

* Node.js
* npm
* Python 3.x
* Arduino IDE if using physical sensors

---

### Install Node.js Dependencies

```bash
npm install
```

---

### Install Python Dependencies

```bash
pip install -r requirements.txt
```

---

### Train the Models

```bash
python train_models.py
```

This trains the machine learning models using the available historical data.

---

### Start the Backend

```bash
node server.js
```

---

### Start Sensor Simulation

In another terminal:

```bash
node simulation.js
```

The simulation sends sensor readings to the backend so that the dashboard can display continuously changing environmental conditions.

---

## AI Model Training

SANJEEVANI supports training models using historical environmental data.

The general process is:

```text
Historical Dataset
        |
        v
Data Cleaning
        |
        v
Feature Engineering
        |
        v
Train/Test Split
        |
        v
StandardScaler
        |
        v
Model Training
        |
        v
Performance Evaluation
        |
        v
Saved Model
```

The trained model can then be used by the real-time prediction pipeline.

---

## Risk Classification

The prediction output is converted into an understandable risk category.

| Risk Level | Meaning                          | Recommended Action          |
| ---------- | -------------------------------- | --------------------------- |
| Low        | Normal environmental conditions  | Continue monitoring         |
| Moderate   | Early warning signs detected     | Increase monitoring         |
| High       | Significant disaster probability | Prepare emergency response  |
| Critical   | Immediate danger                 | Activate emergency response |

---

## Disaster Response Workflow

```text
Detect
  |
  v
Analyze
  |
  v
Predict
  |
  v
Classify Risk
  |
  v
Locate Affected Area
  |
  v
Generate Alert
  |
  v
Notify Authorities
  |
  v
Inform Citizens
  |
  v
Emergency Response
```

---

## Future Scope

SANJEEVANI can be extended with:

* Real satellite and weather data integration
* Live GPS-based citizen tracking
* SMS and WhatsApp emergency alerts
* Government emergency service integration
* Advanced GIS-based disaster mapping
* More IoT sensors
* Edge AI for local disaster detection
* Mobile application
* Multilingual citizen alerts
* Automated evacuation route generation
* Cloud deployment
* Real-time emergency resource allocation
* More advanced deep learning models

---

## Applications

SANJEEVANI can be used for:

* Flood monitoring
* Gas leak detection
* Industrial safety
* Smart cities
* Disaster management authorities
* Emergency response centers
* Industrial zones
* High-risk geographical areas
* Community disaster warning systems

---

## Hackathon Context

SANJEEVANI is developed as a Smart India Hackathon 2026 project under the disaster management and environmental monitoring domain.

The project focuses on combining IoT, artificial intelligence, real-time monitoring, and emergency response into a unified disaster management platform.

---

## Team

Developed for Smart India Hackathon 2026.

Project Name: SANJEEVANI

Repository: Cmay003/SIH-2026

---

## License

This project is developed for educational, research, and hackathon purposes.
