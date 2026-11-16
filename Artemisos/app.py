"""Compatibility entry point: run `python app.py` or `python api.py`.

Artemisos V2 uses api.py as the single authoritative Flask backend.
The old duplicated backend was intentionally replaced to avoid different
spectrum endpoints depending on which command the team launches.
"""
from api import app

if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
