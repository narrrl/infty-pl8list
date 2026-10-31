# syntax=docker/dockerfile:1
FROM python:3.14-alpine

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=8790 \
    PL8_DB=/data/pl8list.db

WORKDIR /app
COPY *.py ./
COPY static ./static
RUN python -m compileall -q . \
 && adduser -D -H -u 10001 app \
 && mkdir /data && chown app:app /data

USER app
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8790/healthz', timeout=2)"
CMD ["python", "server.py"]
