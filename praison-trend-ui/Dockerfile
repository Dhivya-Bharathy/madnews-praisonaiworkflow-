FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

ENV PORT=8780
EXPOSE 8780

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8780}"]
