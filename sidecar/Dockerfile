FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py recorder.py instagram.py .

RUN mkdir -p /data/recordings && chmod -R 777 /data

ENV MEDIA_DIR=/data \
    PORT=7860

EXPOSE 7860

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
