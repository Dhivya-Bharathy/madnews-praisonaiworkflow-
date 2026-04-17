FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Railway/Render/Fly set PORT; default 8790 for local Docker
ENV PORT=8790
EXPOSE 8790

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8790}"]
