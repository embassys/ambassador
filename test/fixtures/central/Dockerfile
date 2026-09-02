FROM python:3.13.15-slim-trixie@sha256:7e3a6aca9d74f93cca21a91d86a8dad8c34749afd5b4a98ee481c9c47b9f5ed4 AS dependencies

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --gid 10001 fixture \
    && useradd --uid 10001 --gid fixture --no-create-home --shell /usr/sbin/nologin fixture

WORKDIR /app

COPY requirements.lock ./requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.lock

COPY THIRD_PARTY_NOTICES.md /licenses/THIRD_PARTY_NOTICES.md


FROM dependencies AS test

COPY --chown=fixture:fixture app.py test_app.py ./
USER fixture
RUN python -m unittest -v test_app.py


FROM dependencies AS runtime

COPY --chown=fixture:fixture app.py ./app.py
USER fixture
EXPOSE 8000

HEALTHCHECK --interval=2s --timeout=2s --start-period=5s --retries=10 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=1).read()"]

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--no-server-header"]
